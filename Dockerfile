# Use uma imagem base do Node.js
FROM node:20

# Atualizar pacotes e instalar Python
RUN apt-get update && apt-get install -y python3 python3-pip

# Instale FFmpeg
RUN apt-get update && apt-get install -y ffmpeg

# Definir o diretório de trabalho
WORKDIR /app

# Copiar os arquivos de configuração do projeto
COPY package.json yarn.lock /app/

# Instalar as dependências
RUN yarn install --frozen-lockfile

# Copiar o restante do código
COPY . /app/

# Expor a porta 3000
EXPOSE 3000

# Rodar o servidor (ajuste se necessário)
CMD ["node", "src/index.js"]
