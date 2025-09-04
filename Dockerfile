# Imagem base oficial Node
FROM node:20-alpine

# Definir diretório de trabalho
WORKDIR /app

# Copiar arquivos de dependência primeiro (cache de build)
COPY package*.json ./

# Instalar dependências
RUN npm install --production

# Copiar restante da aplicação
COPY . .

# Definir variável de ambiente padrão (pode ser sobrescrita pelo EasyPanel)
ENV PORT=3000

# Expor a porta configurada
EXPOSE $PORT

# Start
CMD ["node", "index.js"]
