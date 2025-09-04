const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const xlsx = require("xlsx");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();
const upload = multer({ dest: "uploads/" });

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Servir frontend
app.use(express.static(path.join(__dirname, "public")));


// Função para extrair texto conforme o tipo de arquivo
async function extractText(filePath, mimetype, originalname) {
  const ext = path.extname(originalname).toLowerCase();

  if (ext === ".pdf") {
    const data = await pdfParse(fs.readFileSync(filePath));
    return data.text;
  }

  if (ext === ".docx") {
    const { value } = await mammoth.extractRawText({ path: filePath });
    return value;
  }

  if (ext === ".xls" || ext === ".xlsx") {
    const workbook = xlsx.readFile(filePath);
    let text = "";
    workbook.SheetNames.forEach((sheet) => {
      text += xlsx.utils.sheet_to_csv(workbook.Sheets[sheet]);
    });
    return text;
  }

  if (ext === ".txt" || mimetype === "text/plain") {
    return fs.readFileSync(filePath, "utf8");
  }

  throw new Error("Tipo de arquivo não suportado");
}

// Rota principal
app.post("/extract", upload.single("file"), async (req, res) => {
  const filePath = req.file.path;

  try {
    const message = req.body.promptMessage;
    const fileText = await extractText(filePath, req.file.mimetype, req.file.originalname);

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
  } finally {
    // 🔥 limpeza garantida
    if (filePath && fs.existsSync(filePath)) {
      fs.unlink(filePath, (err) => {
        if (err) console.error("Erro ao deletar arquivo temporário:", err);
      });
    }
  }
});


app.listen(3000, () => console.log("🚀 Servidor rodando em http://localhost:3000"));
