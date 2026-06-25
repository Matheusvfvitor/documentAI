const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const xlsx = require("xlsx");
const OpenAI = require("openai");
const path = require("path");
require("dotenv").config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const BATCH_SIZE = Number(process.env.COND_BATCH_SIZE || 10);
const MAX_INDEX_TOKENS = Number(process.env.MAX_INDEX_TOKENS || 10000);
const MAX_BATCH_TOKENS = Number(process.env.MAX_BATCH_TOKENS || 14000);
const MAX_DADOS_TOKENS = Number(process.env.MAX_DADOS_TOKENS || 5000);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Middleware global de CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

// Servir frontend (pasta public/)
app.use(express.static(path.join(__dirname, "public")));

function normalizeExtractedText(text = "") {
  return String(text || "")
    .normalize("NFC")
    // Remove caracteres de controle, preservando \n e \t.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\f/g, "\n")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function sanitizeLLMJson(raw = "") {
  return String(raw || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim();
}

function normalizeUid(value) {
  if (!value) return null;

  const text = String(value).trim().toLowerCase();
  const match = text.match(/c\d{1,6}/);

  if (!match) return null;

  const number = match[0].replace("c", "");

  return `c${number.padStart(3, "0")}`;
}

function parseLLMJson(raw, label = "resposta") {
  const sanitized = sanitizeLLMJson(raw);

  try {
    return JSON.parse(sanitized);
  } catch (err1) {
    const match = sanitized.match(/\{[\s\S]*\}/);

    if (!match) {
      throw new Error(`${label}: resposta do modelo não contém JSON`);
    }

    try {
      return JSON.parse(match[0]);
    } catch (err2) {
      console.error(`[${label}] JSON bruto:`, raw);
      console.error(`[${label}] JSON sanitizado:`, sanitized);
      throw new Error(`${label}: JSON inválido após sanitização`);
    }
  }
}

function onlyDigits(value) {
  if (value === null || value === undefined) return null;
  const digits = String(value).replace(/\D/g, "");
  return digits || null;
}

function normalizeDateString(value) {
  if (!value) return null;

  const text = String(value).trim();

  // yyyy/mm/dd ou yyyy-mm-dd
  const ymd = text.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if (ymd) {
    const [, y, m, d] = ymd;
    return `${y}/${m.padStart(2, "0")}/${d.padStart(2, "0")}`;
  }

  // dd/mm/yyyy ou dd-mm-yyyy
  const dmy = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}/${m.padStart(2, "0")}/${d.padStart(2, "0")}`;
  }

  return text;
}

async function extractText(fileBuffer, mimetype = "", originalname = "") {
  const ext = path.extname(originalname || "").toLowerCase();

  if (mimetype === "application/pdf" || ext === ".pdf") {
    const data = await pdfParse(fileBuffer);
    return normalizeExtractedText(data.text || "");
  }

  if (
    mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === ".docx"
  ) {
    const result = await mammoth.extractRawText({ buffer: fileBuffer });
    return normalizeExtractedText(result.value || "");
  }

  if (
    mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mimetype === "application/vnd.ms-excel" ||
    [".xlsx", ".xls", ".csv"].includes(ext)
  ) {
    const workbook = xlsx.read(fileBuffer, { type: "buffer" });
    const sheetsText = workbook.SheetNames.map((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      const csv = xlsx.utils.sheet_to_csv(sheet, { blankrows: false });
      return `--- ABA: ${sheetName} ---\n${csv}`;
    }).join("\n\n");

    return normalizeExtractedText(sheetsText);
  }

  if (mimetype.startsWith("text/") || [".txt", ".md", ".json"].includes(ext)) {
    return normalizeExtractedText(fileBuffer.toString("utf8"));
  }

  throw new Error(`Tipo de arquivo não suportado: ${mimetype || ext || "desconhecido"}`);
}

const PROMPT_LIC_RULES = `
Você é um especialista sênior em licenciamento ambiental, compliance regulatório
e análise documental jurídica no Brasil.

Sua tarefa é EXTRAIR TODAS as informações relevantes da LICENÇA AMBIENTAL
fornecida, incluindo OBRIGATORIAMENTE TODAS as CONDICIONANTES,
sem omitir absolutamente nenhum dado normativo, técnico ou regulatório.

━━━━━━━━━━━━━━━━━━━━━━
REGRAS ABSOLUTAS (NÃO VIOLAR)
━━━━━━━━━━━━━━━━━━━━━━
0. Ignore caracteres inválidos, quebras artificiais de OCR e ruídos de layout.
1. NÃO resumir, NÃO interpretar juridicamente e NÃO reescrever o texto original,
   exceto nos campos explicitamente definidos como “resumo” ou “nome”.
2. Copiar o texto das condicionantes EXATAMENTE como consta no documento (verbatim),
   unificando quebras de página e linha quando necessário.
3. Considerar como informação válida TODO texto que:
   - gere obrigação
   - gere restrição
   - gere vedação
   - gere autorização condicionada
   - gere prazo, frequência ou exigência documental
4. NÃO inferir informações ausentes.
5. Se algum campo não existir no documento, retornar null.
6. NÃO incluir QR Codes, assinaturas digitais, carimbos, códigos de autenticação
   ou textos meramente institucionais.
7. Priorizar EXAUSTIVIDADE TOTAL sobre concisão.

━━━━━━━━━━━━━━━━━━━━━━
REGRA CRÍTICA – CONTROLE DE SEÇÃO
━━━━━━━━━━━━━━━━━━━━━━

O documento PODE possuir as seguintes seções, mesmo que o layout esteja quebrado:

- “Condicionantes Orientativas”
- “Condicionantes Gerais”
- “Condicionantes Específicas”
- “Exigências Técnicas”
- “Exigências”
- “Observações”
- “Nota”

REGRAS OBRIGATÓRIAS DE SEÇÃO:

1. Sempre que surgir um texto que contenha a palavra “Condicionantes”
   ou uma lista numerada de obrigações, INICIA-SE uma seção de condicionantes.
2. Se a numeração reiniciar em “1” após uma sequência longa (ex: após 30+ itens),
   o modelo DEVE interpretar isso como INÍCIO DE UMA NOVA SEÇÃO,
   mesmo que o cabeçalho não esteja claramente visível.
3. A seção “Condicionantes Específicas” SEMPRE reinicia a numeração em 1.
4. A seção “Nota” NÃO é condicionante, EXCETO se contiver prazos,
   obrigações ou regras de contagem de prazo – nesses casos,
   o conteúdo DEVE ser incluído como condicionante do tipo "geral".

━━━━━━━━━━━━━━━━━━━━━━
CLASSIFICAÇÃO DO TIPO DA CONDICIONANTE
━━━━━━━━━━━━━━━━━━━━━━

- Seção “Condicionantes Orientativas” → tipo = "orientativa"
- Seção “Condicionantes Gerais”      → tipo = "geral"
- Seção “Condicionantes Específicas” → tipo = "especifica"
- Exigências técnicas / observações obrigatórias → tipo = "geral"

O campo "tipo" DEVE refletir a SEÇÃO REAL, e NÃO o conteúdo semântico.

━━━━━━━━━━━━━━━━━━━━━━
REGRAS DE PRAZO (OBRIGATÓRIAS)
━━━━━━━━━━━━━━━━━━━━━━

1. Sempre que uma condicionante contiver prazo expresso em DIAS,
   como:
   - “em até X dias”
   - “em X dias”
   - “no prazo de X dias”
   - “com antecedência mínima de X dias”

   o campo "prazo" DEVE ser convertido em DATA FINAL ABSOLUTA,
   somando X dias corridos à data de emissão da licença.

2. Data de emissão = dia 0.
3. Contagem em dias corridos (inclusive finais de semana).
4. Formato obrigatório: aaaa/mm/dd.

EXEMPLO:
Data de emissão: 02/07/2024
Texto: “Providenciar, em até 30 dias, a publicação…”
prazo = "2024/08/01"

5. Quando o prazo estiver expresso em HORAS:
   - prazo = null
   - manter a informação no texto.

6. Quando houver apenas periodicidade (mensal, trimestral, semestral, anual):
   - prazo = null
   - preencher corretamente "frequencia".

7. Quando o prazo estiver condicionado a evento futuro
   (“antes do início da safra”, “após conclusão das obras”):
   - prazo = null
   - evento deve permanecer no texto.

NENHUM prazo em dias pode permanecer null
se for possível calcular a data final.

━━━━━━━━━━━━━━━━━━━━━━
DADOS A SEREM EXTRAÍDOS
━━━━━━━━━━━━━━━━━━━━━━

### DADOS DA LICENÇA
- orgao_emissor
- sistema_emissor (se existir)
- tipo da licença (LP, LI, LO, LF, RA, etc.)
- nome da licença
- número da licença
- número do processo
- data_emissao
- data_validade
- description: Descrição curta do conteúdo da licença
- protocolo (se existir)
- processo (se existir)

### DADOS DO EMPREENDEDOR
- empresa_responsavel
- cpf_cnpj (apenas números)

━━━━━━━━━━━━━━━━━━━━━━
REGRA DE JSON (CRÍTICA):
━━━━━━━━━━━━━━━━━━━━━━

- Todo campo do tipo string DEVE ter caracteres de controle escapados.
- Quebras de linha DEVEM ser representadas como \\n
- Aspas internas DEVEM ser escapadas como \\\".

━━━━━━━━━━━━━━━━━━━━━━
REGRA DE IDENTIFICAÇÃO DA NUMERAÇÃO E COMPOSIÇÃO DO NOME
━━━━━━━━━━━━━━━━━━━━━━

As condicionantes podem reiniciar a numeração dentro de cada seção
(geral, específica, orientativa ou outras).

Portanto o campo "numero" NÃO é global e pode se repetir.

O modelo deve sempre extrair:

numero → número da condicionante dentro da seção
nome   → composto por número + tipo + descrição curta

━━━━━━━━━━━━━━━━━━━━━━
EXTRAÇÃO DA NUMERAÇÃO
━━━━━━━━━━━━━━━━━━━━━━

Considere como número válido quando aparecer no início do item:

Exemplos válidos:

1.
1 -
1)
01.
1.1
2.3.1

Regra:

numero = apenas o número identificado
(remover ponto, hífen ou parênteses)

Exemplo:

"3. Apresentar relatório anual"

numero = "3"

Se não existir número:

numero = "sn"

━━━━━━━━━━━━━━━━━━━━━━
COMPOSIÇÃO DO CAMPO "nome"
━━━━━━━━━━━━━━━━━━━━━━

O campo "nome" deve ser um título curto (máx 120 caracteres)
seguindo o padrão:

<numero> - <tipo da condicionante>: <descrição curta>

TIPOS VÁLIDOS:

Condicionantes Gerais
Condicionantes Específicas
Condicionantes Orientativas
Outras Condicionantes

MAPEAMENTO:

tipo = "geral"
nome = "<numero> - Condicionante Geral: <descrição curta>"

tipo = "especifica"
nome = "<numero> - Condicionante Específica: <descrição curta>"

tipo = "orientativa"
nome = "<numero> - Condicionante Orientativa: <descrição curta>"

tipo = qualquer outro
nome = "<numero> - Outras Condicionantes: <descrição curta>"

━━━━━━━━━━━━━━━━━━━━━━
REGRAS DA DESCRIÇÃO CURTA
━━━━━━━━━━━━━━━━━━━━━━

A descrição curta deve:

- resumir a obrigação principal
- remover textos legais longos
- remover referências normativas
- remover números de lei ou resolução
- remover unidades, datas ou valores
- conter no máximo 120 caracteres
- ser uma frase curta e clara

━━━━━━━━━━━━━━━━━━━━━━
CONDICIONANTES – CAMPOS OBRIGATÓRIOS
━━━━━━━━━━━━━━━━━━━━━━

Para CADA condicionante identificada, retornar:

- nome        → título curto (até 100 caracteres)
- texto       → texto integral (verbatim)
- numero      → numeração oficial
- tipo        → tipo da condicionante
- prazo       → data final (aaaa/mm/dd) ou null
- frequencia  → se aplicável
- emissao     → data de emissão da licença
- resumo      → frase única e objetiva da obrigação
`;

function finalShape() {
  return {
    cpf_cnpj: null,
    orgao_emissor: null,
    sistema_emissor: null,
    data_emissao: null,
    data_validade: null,
    empresa_responsavel: null,
    doc_number: null,
    docObj: null,
    description: null,
    responsavel: null,
    responsavel_email: null,
    nome: null,
    protocolo: null,
    processo: null,
    condicionantes: []
  };
}

function normalizeDadosGerais(data = {}) {
  const base = finalShape();

  return {
    ...base,
    cpf_cnpj: onlyDigits(data.cpf_cnpj),
    orgao_emissor: data.orgao_emissor ?? null,
    sistema_emissor: data.sistema_emissor ?? null,
    data_emissao: normalizeDateString(data.data_emissao),
    data_validade: normalizeDateString(data.data_validade),
    empresa_responsavel: data.empresa_responsavel ?? null,
    doc_number: data.doc_number ?? data.numero_licenca ?? null,
    docObj: data.docObj ?? data.tipo_licenca ?? data.tipo ?? null,
    description: data.description ?? null,
    responsavel: data.responsavel ?? null,
    responsavel_email: data.responsavel_email ?? null,
    nome: data.nome ?? data.nome_licenca ?? null,
    protocolo: data.protocolo ?? null,
    processo: data.processo ?? data.numero_processo ?? null,
    condicionantes: []
  };
}

function normalizeCondicionante(item = {}, dadosGerais = {}) {
  return {
    nome: item.nome ?? null,
    texto: item.texto ?? "",
    prazo: normalizeDateString(item.prazo),
    resumo: item.resumo ?? null,
    emissao: normalizeDateString(item.emissao || dadosGerais.data_emissao),
    frequencia: item.frequencia ?? "",
    numero: item.numero === undefined || item.numero === null ? "sn" : String(item.numero),
    tipo: item.tipo ?? "outro"
  };
}

async function callJsonLLM({ label, messages, maxTokens }) {
  const response = await client.chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    messages,
    temperature: 0,
    max_tokens: maxTokens
  });

  const choice = response.choices?.[0];
  const finishReason = choice?.finish_reason;
  const raw = choice?.message?.content || "";

  if (finishReason === "length") {
    console.error(`[${label}] Resposta truncada por limite de tokens.`);
    console.error(`[${label}] JSON parcial:`, raw);
    throw new Error(`${label}: resposta truncada por limite de tokens`);
  }

  return parseLLMJson(raw, label);
}

async function extractDadosGerais(fileText, promptMessage = "") {
  const prompt = `
${PROMPT_LIC_RULES}

TAREFA DESTA ETAPA:
Extraia SOMENTE os dados gerais da licença ambiental.
NÃO extraia condicionantes nesta etapa.

Retorne APENAS JSON válido no formato exato:
{
  "cpf_cnpj": null,
  "orgao_emissor": null,
  "sistema_emissor": null,
  "data_emissao": null,
  "data_validade": null,
  "empresa_responsavel": null,
  "doc_number": null,
  "docObj": null,
  "description": null,
  "responsavel": null,
  "responsavel_email": null,
  "nome": null,
  "protocolo": null,
  "processo": null
}

Instrução adicional do usuário, se houver:
${promptMessage || "Nenhuma."}

DOCUMENTO:
${fileText}
`;

  const result = await callJsonLLM({
    label: "dados_gerais",
    maxTokens: MAX_DADOS_TOKENS,
    messages: [
      {
        role: "system",
        content: "Você é um extrator de dados de licença ambiental. Retorne somente JSON válido."
      },
      { role: "user", content: prompt }
    ]
  });

  return normalizeDadosGerais(result);
}

async function createCondicionantesIndex(fileText, dadosGerais, promptMessage = "") {
  const prompt = `
${PROMPT_LIC_RULES}

TAREFA DESTA ETAPA:
Identifique TODAS as condicionantes, exigências, observações obrigatórias, notas obrigatórias, vedações e autorizações condicionadas do documento.
NÃO extraia o texto completo nesta etapa.
Crie apenas um ÍNDICE para controlar os batches.

REGRAS DO ÍNDICE:
- Cada item do índice deve representar uma condicionante real que será extraída depois.
- Preserve a ordem de aparição no documento.
- Se a numeração reiniciar em nova seção, mantenha o mesmo numero, mas altere section_name, tipo e uid.
- uid deve ser único e sequencial no formato "c001", "c002", "c003".
- ordem deve ser número sequencial inteiro começando em 1.
- total_condicionantes deve ser igual ao tamanho do array condicionantes.

Retorne APENAS JSON válido neste formato:
{
  "total_condicionantes": 0,
  "condicionantes": [
    {
      "uid": "c001",
      "ordem": 1,
      "numero": "1",
      "tipo": "geral",
      "section_name": "Condicionantes Gerais",
      "titulo_curto": "Descrição curta sem texto completo"
    }
  ]
}

Dados gerais já extraídos:
${JSON.stringify(dadosGerais, null, 2)}

Instrução adicional do usuário, se houver:
${promptMessage || "Nenhuma."}

DOCUMENTO:
${fileText}
`;

  const result = await callJsonLLM({
    label: "indice_condicionantes",
    maxTokens: MAX_INDEX_TOKENS,
    messages: [
      {
        role: "system",
        content: "Você é um indexador de condicionantes ambientais. Retorne somente JSON válido."
      },
      { role: "user", content: prompt }
    ]
  });

  const condicionantes = Array.isArray(result.condicionantes) ? result.condicionantes : [];

  return {
    total_condicionantes: Number(result.total_condicionantes || condicionantes.length),
    condicionantes: condicionantes.map((item, index) => ({
      uid: item.uid || `c${String(index + 1).padStart(3, "0")}`,
      ordem: Number(item.ordem || index + 1),
      numero: item.numero === undefined || item.numero === null ? "sn" : String(item.numero),
      tipo: item.tipo || "outro",
      section_name: item.section_name || null,
      titulo_curto: item.titulo_curto || null
    }))
  };
}

function createBatchesFromIndex(index, size = BATCH_SIZE) {
  const items = index.condicionantes || [];
  const batches = [];

  for (let i = 0; i < items.length; i += size) {
    const batchItems = items.slice(i, i + size);

    batches.push({
      batchNumber: batches.length + 1,
      items: batchItems,
      startUid: batchItems[0]?.uid,
      endUid: batchItems[batchItems.length - 1]?.uid,
      startOrdem: batchItems[0]?.ordem,
      endOrdem: batchItems[batchItems.length - 1]?.ordem
    });
  }

  return batches;
}

async function extractCondicionantesBatch(fileText, batch, dadosGerais, promptMessage = "") {
  const prompt = `
${PROMPT_LIC_RULES}

TAREFA DESTA ETAPA:
Extraia do documento SOMENTE as condicionantes listadas no BATCH abaixo.
Preserve o texto integral/verbatim de cada condicionante solicitada.
NÃO extraia condicionantes fora deste batch.

BATCH ATUAL:
${JSON.stringify(batch.items, null, 2)}

REGRAS ADICIONAIS DO BATCH:
- Retorne uma condicionante para cada item do BATCH ATUAL.
- Mantenha o campo interno "uid" para conferência. Ele será removido antes da resposta final.
- O campo "texto" deve conter o texto integral da condicionante, unificando quebras de página/linha quando necessário.
- Não resumir o campo "texto".
- Não omitir itens por parecerem genéricos.
- Se o item for nota/observação com obrigação ou regra de prazo, incluir como tipo "geral".
- Use a data de emissão dos dados gerais para calcular prazos em dias.
- Retorne APENAS JSON válido, sem markdown e sem explicações.

Retorne APENAS este formato:
{
  "condicionantes": [
    {
      "uid": "c001",
      "nome": "<numero> - Condicionante Geral: <descrição curta>",
      "texto": "texto integral verbatim",
      "prazo": null,
      "resumo": "frase única e objetiva da obrigação",
      "emissao": "aaaa/mm/dd",
      "frequencia": "",
      "numero": "1",
      "tipo": "geral"
    }
  ]
}

Dados gerais já extraídos:
${JSON.stringify(dadosGerais, null, 2)}

Instrução adicional do usuário, se houver:
${promptMessage || "Nenhuma."}

DOCUMENTO:
${fileText}
`;

  const result = await callJsonLLM({
    label: `batch_${batch.batchNumber}_${batch.startUid}_${batch.endUid}`,
    maxTokens: MAX_BATCH_TOKENS,
    messages: [
      {
        role: "system",
        content: "Você é um extrator de condicionantes ambientais. Retorne somente JSON válido."
      },
      { role: "user", content: prompt }
    ]
  });

const condicionantes = Array.isArray(result.condicionantes) ? result.condicionantes : [];

return condicionantes.map((item, index) => {
  const expectedItem = batch.items[index];
  const uidFromModel = normalizeUid(item.uid);
  const uid = uidFromModel || expectedItem?.uid || null;

  if (!uidFromModel && expectedItem?.uid) {
    console.warn(
      `[batch ${batch.batchNumber}] UID ausente no item ${index + 1}; reassociando por posição: ${expectedItem.uid}`
    );
  }

  return {
    uid,
    ...normalizeCondicionante(
      {
        ...item,
        numero: item.numero ?? expectedItem?.numero ?? "sn",
        tipo: item.tipo ?? expectedItem?.tipo ?? "outro"
      },
      dadosGerais
    )
  };
});
}

function findMissingUids(batch, extracted) {
  const expected = new Set((batch.items || []).map((item) => item.uid));

  const found = new Set(
    (extracted || [])
      .map((item) => normalizeUid(item.uid))
      .filter(Boolean)
  );

  return [...expected].filter((uid) => !found.has(uid));
}

async function processBatchWithFallback(fileText, batch, dadosGerais, promptMessage = "") {
  try {
    const extracted = await extractCondicionantesBatch(fileText, batch, dadosGerais, promptMessage);
    const missing = findMissingUids(batch, extracted);

    if (missing.length > 0) {
      throw new Error(
        `Batch ${batch.batchNumber} retornou ${extracted.length}/${batch.items.length}. Faltantes: ${missing.join(", ")}`
      );
    }

    return extracted;
  } catch (error) {
    console.warn(`[batch ${batch.batchNumber}] Falha: ${error.message}`);

    if ((batch.items || []).length <= 1) {
      throw error;
    }

    const middle = Math.ceil(batch.items.length / 2);
    const leftItems = batch.items.slice(0, middle);
    const rightItems = batch.items.slice(middle);

    const leftBatch = {
      ...batch,
      batchNumber: `${batch.batchNumber}.1`,
      items: leftItems,
      startUid: leftItems[0]?.uid,
      endUid: leftItems[leftItems.length - 1]?.uid
    };

    const rightBatch = {
      ...batch,
      batchNumber: `${batch.batchNumber}.2`,
      items: rightItems,
      startUid: rightItems[0]?.uid,
      endUid: rightItems[rightItems.length - 1]?.uid
    };

    const left = await processBatchWithFallback(fileText, leftBatch, dadosGerais, promptMessage);
    const right = await processBatchWithFallback(fileText, rightBatch, dadosGerais, promptMessage);

    return [...left, ...right];
  }
}

function stripInternalFields(condicionantes = []) {
  return condicionantes.map((item) => ({
    nome: item.nome ?? null,
    texto: item.texto ?? "",
    prazo: item.prazo ?? null,
    resumo: item.resumo ?? null,
    emissao: item.emissao ?? null,
    frequencia: item.frequencia ?? "",
    numero: item.numero ?? "sn",
    tipo: item.tipo ?? "outro"
  }));
}

function validateFinalExtraction(index, condicionantesWithUid) {
  const expected = (index.condicionantes || []).map((item) => item.uid);
  const extracted = (condicionantesWithUid || []).map((item) => item.uid).filter(Boolean);

  const expectedSet = new Set(expected);
  const extractedSet = new Set(extracted);

  const missing = expected.filter((uid) => !extractedSet.has(uid));
  const duplicated = extracted.filter((uid, idx, arr) => arr.indexOf(uid) !== idx);
  const unexpected = extracted.filter((uid) => !expectedSet.has(uid));

  return {
    ok: missing.length === 0 && duplicated.length === 0,
    expected: expected.length,
    extracted: extracted.length,
    missing,
    duplicated: [...new Set(duplicated)],
    unexpected: [...new Set(unexpected)]
  };
}

async function extractCondicionantesInBatches(fileText, dadosGerais, promptMessage = "") {
  const index = await createCondicionantesIndex(fileText, dadosGerais, promptMessage);
  const batches = createBatchesFromIndex(index, BATCH_SIZE);

  console.log(
    `[extract] Índice criado: ${index.total_condicionantes} condicionantes em ${batches.length} batch(es) de até ${BATCH_SIZE}.`
  );

  const condicionantesWithUid = [];

  for (const batch of batches) {
    console.log(
      `[extract] Extraindo batch ${batch.batchNumber}: ordem ${batch.startOrdem} até ${batch.endOrdem} (${batch.startUid} → ${batch.endUid})`
    );

    const batchResult = await processBatchWithFallback(fileText, batch, dadosGerais, promptMessage);
    condicionantesWithUid.push(...batchResult);
  }

  const validation = validateFinalExtraction(index, condicionantesWithUid);

  if (!validation.ok) {
    console.error("[extract] Validação final falhou:", validation);
    throw new Error(
      `Extração incompleta. Esperadas: ${validation.expected}. Extraídas: ${validation.extracted}. Faltantes: ${validation.missing.join(", ")}`
    );
  }

  console.log("[extract] Validação final OK:", validation);

  return stripInternalFields(condicionantesWithUid);
}

async function extractLicenca(fileBuffer, mimetype, originalname, promptMessage = "") {
  const fileText = await extractText(fileBuffer, mimetype, originalname);

  if (!fileText || fileText.length < 20) {
    throw new Error("Não foi possível extrair texto suficiente do arquivo.");
  }

  console.log(`[extract] Texto extraído: ${fileText.length} caracteres.`);

  const dadosGerais = await extractDadosGerais(fileText, promptMessage);
  const condicionantes = await extractCondicionantesInBatches(fileText, dadosGerais, promptMessage);

  return {
    cpf_cnpj: dadosGerais.cpf_cnpj,
    orgao_emissor: dadosGerais.orgao_emissor,
    sistema_emissor: dadosGerais.sistema_emissor,
    data_emissao: dadosGerais.data_emissao,
    data_validade: dadosGerais.data_validade,
    empresa_responsavel: dadosGerais.empresa_responsavel,
    doc_number: dadosGerais.doc_number,
    docObj: dadosGerais.docObj,
    description: dadosGerais.description,
    responsavel: dadosGerais.responsavel,
    responsavel_email: dadosGerais.responsavel_email,
    nome: dadosGerais.nome,
    protocolo: dadosGerais.protocolo,
    processo: dadosGerais.processo,
    condicionantes
  };
}

app.post("/extract", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Arquivo não enviado" });
    }

    const promptMessage = req.body.promptMessage || "";

    const result = await extractLicenca(
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname,
      promptMessage
    );

    return res.json(result);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Falha na extração",
      details: error.message
    });
  }
});

app.get("/health", (req, res) => {
  res.json({ ok: true, model: MODEL, batchSize: BATCH_SIZE });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});

module.exports = {
  app,
  extractLicenca,
  extractText,
  normalizeExtractedText,
  sanitizeLLMJson,
  parseLLMJson,
  extractDadosGerais,
  createCondicionantesIndex,
  createBatchesFromIndex,
  extractCondicionantesBatch,
  extractCondicionantesInBatches
};



/* const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const xlsx = require("xlsx");
const OpenAI = require("openai");
require("dotenv").config();

function sanitizeLLMJson(raw) {
  if (!raw || typeof raw !== "string") return raw;

  return raw
    // normaliza unicode (REMOVE variações perigosas)
    .normalize("NFKC")

    // remove caracteres de controle invisíveis
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")

    // remove separadores de linha unicode (matam JSON)
    .replace(/\u2028|\u2029/g, "")

    // escapa quebras
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

const app = express();

// Middleware global de CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*"); // libera todas as origens
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // Responde preflight OPTIONS automaticamente
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});


const upload = multer({ storage: multer.memoryStorage() }); // 👈 memória

// Cliente OpenAI
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Servir frontend (pasta public/)
const path = require("path");
app.use(express.static(path.join(__dirname, "public")));

// Função para extrair texto conforme o tipo de arquivo
async function extractText(fileBuffer, mimetype, originalname) {
  const ext = path.extname(originalname).toLowerCase();

  if (ext === ".pdf") {
    const data = await pdfParse(fileBuffer);
    return data.text;
  }

  if (ext === ".docx") {
    const { value } = await mammoth.extractRawText({ buffer: fileBuffer });
    return value;
  }

  if (ext === ".xls" || ext === ".xlsx") {
    const workbook = xlsx.read(fileBuffer, { type: "buffer" });
    let text = "";
    workbook.SheetNames.forEach((sheet) => {
      text += xlsx.utils.sheet_to_csv(workbook.Sheets[sheet]);
    });
    return text;
  }

  if (ext === ".txt" || mimetype === "text/plain") {
    return fileBuffer.toString("utf8");
  }

  throw new Error("Tipo de arquivo não suportado");
}

// Rota principal
app.post("/extract", upload.single("file"), async (req, res) => {
  try {
    const message = req.body.promptMessage;
    const fileText = await extractText(req.file.buffer, req.file.mimetype, req.file.originalname);

    // Prompt para o LLM
    const prompt = `${message}
--- DOCUMENTO ---
${fileText}`;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
       {role: "system",
        content: `
      Você é um extrator de dados.
      REGRAS DE JSON (OBRIGATÓRIAS):
      - Retorne APENAS JSON válido.
      - Todas as strings DEVEM escapar caracteres de controle.
      - Quebras de linha DEVEM ser representadas como \\n
      - Tabs como \\t
      - Aspas internas como \"
      - Nunca utilize quebras de linha reais dentro de strings.
      `},
        { role: "user", content: prompt }
      ],
      temperature: 0
    });

let extractedRaw = response.choices[0].message.content;

// 1️⃣ sanitiza sempre
let sanitized = sanitizeLLMJson(extractedRaw);

// 2️⃣ tenta parse direto
try {
  extracted = JSON.parse(sanitized);
} catch (err1) {

  // 3️⃣ tenta extrair somente o bloco JSON
  const match = sanitized.match(/\{[\s\S]*\}/);

  if (!match) {
    throw new Error("Resposta do modelo não contém JSON");
  }

  try {
    extracted = JSON.parse(match[0]);
  } catch (err2) {
    console.error("JSON bruto:", extractedRaw);
    console.error("JSON sanitizado:", sanitized);
    throw new Error("JSON inválido após sanitização");
  }
}

    res.json(extracted);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Falha na extração", details: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});*/
