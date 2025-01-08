const express = require('express')
const app = express()
const router = express.Router();
const http = require('http');
app.use(express.json()); // Middleware para análise de solicitações JSON
const youtubedl = require("youtube-dl-exec"); // CommonJS
const ytdl = require("@distube/ytdl-core"); // CommonJS
const ffmpeg = require("fluent-ffmpeg");
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require("uuid"); // Para gerar identificadores únicos
const { PassThrough } = require('stream');
require('dotenv').config();

const server = http.createServer(app);

// Configuração do Socket.io
const { Server } = require('socket.io');
const io = new Server(server, {
  cors: {
    origin: ['https://ytmp4-server-node-express-production.up.railway.app', 'http://localhost:8080', 'https://web-production-9f85.up.railway.app/'], // Permite qualquer origem (ajuste conforme necessário)
    methods: ['GET', 'POST']
  }
});

// Configura o CORS para aceitar requisições de uma origem específica
app.use(cors({
  origin: ['https://web-production-9f85.up.railway.app', 'http://localhost:8080'],
  methods: ['GET', 'POST']
}));


// Defina o caminho para o binário do ffmpeg
const ffmpegPath = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';
ffmpeg.setFfmpegPath(ffmpegPath);
// ffmpeg.setFfmpegPath(path.resolve("C:\\Users\\Dev\\Desktop\\ffmpeg-master-latest-win64-gpl-shared\\bin\\ffmpeg.exe"));

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
  console.log(urlVideo, "urlVideo", qualityFormat, "qualityFormat")
  const resolutionVideo = qualityFormat.match(/\d+/)[0];  // Obtém apenas os números

  if (isProcessing) {
    return res.status(429).json({
      error: "Já existe um processamento em andamento. Tente novamente mais tarde.",
    });
  }

  try {
    const info = await youtubedl(urlVideo, { dumpJson: true });

    // Busque o formato com a resolução desejada
    const selectedFormat = info.formats.find(format => {
      // Pegue a altura da resolução (parte após 'x')
      const resolutionHeight = format.resolution?.split('x')[1];
      return resolutionHeight === resolutionVideo && format.vcodec !== 'none';
    });

    if (!selectedFormat) {
      console.log("Formato não encontrado.");
    }

    // Escolher o ID do formato (resolutionVideo ou 397 = 480p)
    const formatId = selectedFormat ? selectedFormat.format_id : '397';

    // Diretório temporário
    const tempDir = path.resolve(path.resolve(), 'src/downloads');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
    const audioPath = path.resolve(tempDir, 'audio.mp3');
    const videoPath = path.resolve(tempDir, 'video.f399.mp4');

    await youtubedl(urlVideo, {
      output: audioPath,
      format: 'bestaudio'
    }).then(() => {
      console.log("Áudio baixado com sucesso:", audioPath);
    }).catch(err => {
      console.error("Erro ao baixar áudio:", err);
      isProcessing = false; // Certifique-se de liberar o estado
      throw err;
    });

    await youtubedl(urlVideo, {
      output: videoPath,
      format: formatId,
      // mergeOutputFormat: 'mp4',
    }).then(() => {
      console.log("Vídeo baixado com sucesso:", videoPath);
    }).catch(err => {
      console.error("Erro ao baixar vídeo:", err);
      isProcessing = false;
      throw err;
    });

    isProcessing = true;


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
  const outputPath = path.resolve(tempDir, `output.mp4`);

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
