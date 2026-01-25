const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const xlsx = require("xlsx");
const OpenAI = require("openai");
require("dotenv").config();

function sanitizeLLMJson(raw) {
  if (!raw || typeof raw !== "string") return raw;

  return raw
    .replace(/\u0000/g, "")      // null
    .replace(/\u0008/g, "")      // backspace
    .replace(/\u000c/g, "")      // form feed
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
});
