const express = require('express')
const app = express()
const router = express.Router();
const http = require('http');
app.use(express.json()); // Middleware para análise de solicitações JSON
const ytdl = require("@distube/ytdl-core"); // CommonJS
const ffmpeg = require("fluent-ffmpeg");
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require("uuid"); // Para gerar identificadores únicos
const { PassThrough } = require('stream');

const server = http.createServer(app);

// Configuração do Socket.io
const { Server } = require('socket.io');
const io = new Server(server, {
  cors: {
    origin: ['https://strongly-singular-moray.ngrok-free.app', 'http://localhost:8080'], // Permite qualquer origem (ajuste conforme necessário)
    methods: ['GET', 'POST']
  }
});

// Configura o CORS para aceitar requisições de uma origem específica
app.use(cors({
  origin: '*', // Permitir todas as origens (ou especifique a sua)
}));


// Defina o caminho para o binário do ffmpeg
ffmpeg.setFfmpegPath("/usr/bin/ffmpeg"); // Caminho do binário no Linux/Docker

app.post("/yt-video-formats", async (req, res) => {
  console.time("yt-video-formats"); // Inicia o cronômetro
  const { ytUrlVideo } = req.body
  console.log(ytUrlVideo)

  try {

    if (!ytUrlVideo || !ytdl.validateURL(ytUrlVideo)) {
      return res.status(400).json({ error: "URL de vídeo inválida ou não fornecida." });
    }

    const info = await ytdl.getInfo(ytUrlVideo);

    // Obtém o título do vídeo
    let videoTitle = info.videoDetails.title;
    const sanitizedTitle = videoTitle.replace(/[^a-zA-Z0-9\s]/g, '');

    // Obtém a URL da capa do vídeo (thumbnail)
    const thumbnailUrl = info.videoDetails.thumbnails.pop().url; // Pega a melhor qualidade disponível

    // Obtém os formatos de vídeo e áudio disponíveis
    const videoFormats = ytdl.filterFormats(info.formats, "video");

    if (videoFormats.length === 0) {
      return res.status(404).json({ error: "Nenhum formato de vídeo ou áudio disponível." });
    }

    // Formata as informações dos formatos
    // Filtrar formatos para obter apenas um por qualidade
    const uniqueFormats = [];
    const qualities = new Set();

    videoFormats.forEach((format) => {
      if (!qualities.has(format.qualityLabel) && format.qualityLabel !== '1080p') {
        qualities.add(format.qualityLabel);
        uniqueFormats.push({
          quality: format.qualityLabel,
        });
      }
    });

    console.timeEnd("yt-video-formats"); // Encerra o cronômetro
    // Envia os dados como resposta JSON
    return res.json({
      videoTitle: sanitizedTitle,
      thumbnail: thumbnailUrl,
      formats: uniqueFormats,
      message: "Informações recuperadas com sucesso!",
    });

  } catch (error) {
    console.error("Erro ao processar o vídeo:", error);
    return res.status(500).json({ error: "Erro ao recuperar informações do vídeo." });
  }
});


//+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

let isProcessing = false; // Variável para evitar requisições paralelas

const ytVideoAduioDownload = async (req, res, next) => {
  const { urlVideo, qualityFormat, clientId } = req.body
  console.log(urlVideo)
  console.log(qualityFormat, "qualityFormat")

  if (isProcessing) {
    return res.status(429).json({
      error: "Já existe um processamento em andamento. Tente novamente mais tarde.",
    });
  }

  if (!urlVideo || !ytdl.validateURL(urlVideo)) {
    return res.status(400).json({ error: "URL de vídeo inválida ou não fornecida." });
  }

  try {
    const info = await ytdl.getInfo(urlVideo);

    // Obtém os formatos de vídeo e áudio disponíveis
    const videoFormats = ytdl.filterFormats(info.formats, "video");
    const audioFormats = ytdl.filterFormats(info.formats, "audioonly");

    if (videoFormats.length === 0 || audioFormats.length === 0) {
      return res.status(404).json({ error: "Nenhum formato de vídeo ou áudio disponível." });
    }

    const specificVideoFormat = videoFormats.find(
      (format) => format.qualityLabel === qualityFormat) || ytdl.chooseFormat(videoFormats, { quality: "highestvideo" });

    const bestAudioFormat = audioFormats[0];

    const tempDir = path.resolve(__dirname, 'downloads'); // Diretório temporário
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
    const videoPath = path.resolve(tempDir, `video_${Date.now()}.mp4`);
    const audioPath = path.resolve(tempDir, `audio_${Date.now()}.mp3`);

    // Função para baixar arquivos
    const downloadFile = (url, format, outputPath) =>
      new Promise((resolve, reject) => {
        const stream = ytdl(url, { format });
        const writeStream = fs.createWriteStream(outputPath);
        stream.pipe(writeStream);
        stream.on("end", resolve);
        stream.on("error", reject);
        writeStream.on("error", reject);
      });

    isProcessing = true;

    // Aguarda os downloads de vídeo e áudio  
    console.time("downloads de vídeo");
    await downloadFile(urlVideo, specificVideoFormat, videoPath);
    console.timeEnd("downloads de vídeo");
    console.time("downloads de audio");
    await downloadFile(urlVideo, bestAudioFormat, audioPath);
    console.timeEnd("downloads de audio");

    req.videoPath = videoPath;  // Armazenando o caminho do vídeo no req
    req.audioPath = audioPath;  // Armazenando o caminho do áudio no req
    req.clientId = clientId
    next()

  } catch (error) {
    console.error("Erro ao processar o vídeo:", error);
    return res.status(500).json({ error: "Erro ao recuperar informações do vídeo." });
  }
};

// ++++++++++++++++++++++++++++++++++++++++++++++++

const toCombineVideoAudio = async (req, res) => {
  const { videoPath, audioPath, clientId } = req; // Pegando os caminhos do vídeo e áudio de req

  const tempDir = path.resolve(__dirname, 'downloads'); // Diretório temporário
  const outputPath = path.resolve(tempDir, `output_${Date.now()}.mp4`);

  console.time("Verificação de arquivos");
  try {
    if (!fs.existsSync(videoPath) || !fs.existsSync(audioPath)) {
      return res.status(404).send("Arquivos de vídeo ou áudio não encontrados.");
    }
    console.timeEnd("Verificação de arquivos");

    // const outputPath = path.resolve(__dirname, `../output_${uuidv4()}.mp4`);

    console.time("FFmpeg - Processo de combinação");
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .videoCodec("libx264")
      .audioCodec("aac")
      .format("mp4")
      .outputOptions('-preset ultrafast') // Preset mais rápido
      .save(outputPath)
      .on('progress', function (progress) {
        io.to(clientId).emit('progress', { progress: progress.percent.toFixed(1) });
        console.log('progress: ' + progress.percent.toFixed(0))
      })
      .on('end', () => {
        console.timeEnd("FFmpeg - Processo de combinação");
        console.time("Download e limpeza");
        res.download(outputPath, "output.mp4", (err) => {
          isProcessing = false

          fs.unlinkSync(videoPath);
          fs.unlinkSync(audioPath);
          fs.unlinkSync(outputPath);

          console.timeEnd("Download e limpeza");
        })
      })
      .on('error', (err) => console.error('Erro ao combinar arquivos:', err));
  } catch (error) {
    isProcessing = false;
    console.error("Erro ao baixar o vídeo:", error);
    res.status(500).json({ error: "Erro ao baixar o vídeo." });
  }
};

// const toCombineVideoAudio = async (req, res) => {

//   const videoPath = path.resolve(__dirname, "../video.mp4");
//   const audioPath = path.resolve(__dirname, "../audio.mp3");

//   console.time("Verificação de arquivos");
//   try {
//     if (!fs.existsSync(videoPath) || !fs.existsSync(audioPath)) {
//       return res.status(404).send("Arquivos de vídeo ou áudio não encontrados.");
//     }
//     console.timeEnd("Verificação de arquivos");

//     const clientId = req.clientId
//     console.log(clientId, "clientId")
//     const outputPath = path.resolve(__dirname, `../output_${uuidv4()}.mp4`);

//     console.time("FFmpeg - Processo de combinação");
//     // Processa com o FFmpeg
//     ffmpeg()
//       .input(audioPath)
//       .input(videoPath)
//       .videoCodec("libx264")
//       .audioCodec("aac")
//       .format("mp4")
//       .outputOptions('-preset ultrafast') // Preset mais rápido
//       .save(outputPath)
//       .on('progress', function (progress) {
//         io.to(clientId).emit('progress', { progress: progress.percent.toFixed(0) });
//         console.log('progress: ' + progress.percent.toFixed(0))
//       })
//       .on("end", () => {
//         console.timeEnd("FFmpeg - Processo de combinação");
//         console.time("Download e limpeza");
//         res.download(outputPath, "output.mp4", (err) => {
//           isProcessing = false;

//           // Remove arquivos temporários
//           if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
//           if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
//           if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

//           console.timeEnd("Download e limpeza");

//           if (err) {
//             console.error("Erro ao enviar o arquivo:", err);
//             return res.status(500).send("Erro ao enviar o arquivo.");
//           }
//         });
//       })
//       .on("error", (err) => {
//         isProcessing = false;
//         console.error("Erro ao processar o vídeo:", err);
//         res.status(500).send("Erro ao processar o vídeo.");
//       });
//   } catch (error) {
//     isProcessing = false;
//     console.error("Erro ao baixar o vídeo:", error);
//     res.status(500).json({ error: "Erro ao baixar o vídeo." });
//   }
// };

// router.post("/yt-audio-download", fetchLatestVideo, processVideo);
router.post("/yt-download", ytVideoAduioDownload, toCombineVideoAudio);

app.use(router);


server.listen(3333, () => {
  console.log('Server Socket.IO running port 3333');
})


io.on('connection', (socket) => {
  console.log('Um usuário se conectou via WebSocket.', socket.id);
});
