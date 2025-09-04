const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const xlsx = require("xlsx");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();
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
        { role: "system", content: "Você é um extrator de dados que responde sempre em JSON válido." },
        { role: "user", content: prompt }
      ],
      temperature: 0
    });

    let extracted = response.choices[0].message.content;

    try {
      extracted = JSON.parse(extracted);
    } catch (err) {
      const match = extracted.match(/\{[\s\S]*\}/);
      if (match) {
        extracted = JSON.parse(match[0]);
      } else {
        throw new Error("Falha ao converter resposta em JSON");
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
