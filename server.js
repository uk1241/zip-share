const express = require('express');
const multer = require('multer');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const RETENTION_MS = 25 * 60 * 1000;
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

app.set('trust proxy', true);
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public')));

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const files = new Map();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const id = crypto.randomUUID();
    const ext = path.extname(file.originalname).toLowerCase() || '.zip';
    cb(null, `${id}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.zip') {
      return cb(new Error('Only .zip files are allowed'));
    }
    cb(null, true);
  },
});

function buildBaseUrl(req) {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/$/, '');
  }

  return `${req.protocol}://${req.get('host')}`;
}

function renderSharePage({ title, message, buttonUrl, buttonText, showButton }) {
  const buttonMarkup = showButton
    ? `<a class="btn" href="${buttonUrl}">${buttonText}</a>`
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style>
      :root {
        --bg1: #f5efe6;
        --bg2: #d9e7e2;
        --card: rgba(255, 255, 255, 0.9);
        --text: #1d2a35;
        --muted: #4f5d6a;
        --accent: #1e7a50;
        --accentDark: #155a3b;
        --danger: #b71c1c;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 1rem;
        font-family: 'Trebuchet MS', 'Segoe UI', sans-serif;
        color: var(--text);
        background: radial-gradient(circle at 10% 10%, var(--bg2), var(--bg1));
      }

      .card {
        width: min(560px, 100%);
        background: var(--card);
        border-radius: 16px;
        padding: 1.25rem;
        box-shadow: 0 18px 35px rgba(20, 40, 30, 0.14);
        border: 1px solid #c2d5cb;
      }

      h1 {
        margin: 0 0 0.5rem;
        font-size: clamp(1.3rem, 4vw, 1.9rem);
      }

      p {
        margin: 0;
        color: var(--muted);
        line-height: 1.5;
      }

      .btn {
        margin-top: 1rem;
        display: inline-block;
        text-decoration: none;
        color: #fff;
        background: var(--accent);
        padding: 0.7rem 1rem;
        border-radius: 10px;
        font-weight: 700;
      }

      .btn:hover { background: var(--accentDark); }
      .expired { color: var(--danger); font-weight: 700; }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>${title}</h1>
      <p class="${showButton ? '' : 'expired'}">${message}</p>
      ${buttonMarkup}
    </main>
  </body>
</html>`;
}

async function removeFile(id) {
  const meta = files.get(id);
  if (!meta) {
    return;
  }

  try {
    await fsp.unlink(meta.filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`Failed to delete file ${meta.filePath}:`, error);
    }
  }

  files.delete(id);
}

async function cleanupExpiredFiles() {
  const now = Date.now();
  const expiredIds = [];

  for (const [id, meta] of files.entries()) {
    if (now > meta.expiresAt) {
      expiredIds.push(id);
    }
  }

  await Promise.all(
    expiredIds.map((id) =>
      removeFile(id).catch((error) => {
        console.error(`Scheduled cleanup failed for ${id}:`, error);
      })
    )
  );
}

// Decoupled cleanup runs independently from upload requests.
cron.schedule('*/15 * * * *', () => {
  cleanupExpiredFiles().catch((error) => {
    console.error('Scheduled cleanup cycle failed:', error);
  });
});

app.get('/health', (_req, res) => {
  return res.status(200).json({ status: 'ok' });
});

app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const id = path.basename(req.file.filename, path.extname(req.file.filename));
  const expiresAt = Date.now() + RETENTION_MS;

  files.set(id, {
    filePath: req.file.path,
    originalName: req.file.originalname,
    expiresAt,
  });

  const shareUrl = `${buildBaseUrl(req)}/share/${id}`;

  return res.status(201).json({
    message: 'Upload successful',
    shareUrl,
    downloadUrl: shareUrl,
    expiresAt: new Date(expiresAt).toISOString(),
  });
});

app.get('/share/:id', async (req, res) => {
  const { id } = req.params;
  const meta = files.get(id);

  if (!meta) {
    return res.status(404).send(
      renderSharePage({
        title: 'Link Expired',
        message: 'This file is not available. It may have expired or been deleted.',
        buttonUrl: '',
        buttonText: '',
        showButton: false,
      })
    );
  }

  if (Date.now() > meta.expiresAt) {
    await removeFile(id);
    return res.status(404).send(
      renderSharePage({
        title: 'Link Expired',
        message: 'This file has expired. Please ask for a new shared link.',
        buttonUrl: '',
        buttonText: '',
        showButton: false,
      })
    );
  }

  try {
    await fsp.access(meta.filePath, fs.constants.F_OK);
  } catch (_error) {
    await removeFile(id);
    return res.status(404).send(
      renderSharePage({
        title: 'Link Expired',
        message: 'This file is not available. It may have expired or been deleted.',
        buttonUrl: '',
        buttonText: '',
        showButton: false,
      })
    );
  }

  return res.send(
    renderSharePage({
      title: 'File Ready',
      message: `Click the button below to download ${meta.originalName}.`,
      buttonUrl: `/download/${id}`,
      buttonText: 'Download ZIP',
      showButton: true,
    })
  );
});

app.get('/download/:id', async (req, res, next) => {
  const { id } = req.params;
  const meta = files.get(id);

  if (!meta) {
    return res.status(404).send(
      renderSharePage({
        title: 'Link Expired',
        message: 'This file is not available. It may have expired or been deleted.',
        buttonUrl: '',
        buttonText: '',
        showButton: false,
      })
    );
  }

  if (Date.now() > meta.expiresAt) {
    await removeFile(id);
    return res.status(404).send(
      renderSharePage({
        title: 'Link Expired',
        message: 'This file has expired. Please ask for a new shared link.',
        buttonUrl: '',
        buttonText: '',
        showButton: false,
      })
    );
  }

  try {
    await fsp.access(meta.filePath, fs.constants.F_OK);
  } catch (_error) {
    await removeFile(id);
    return res.status(404).send(
      renderSharePage({
        title: 'Link Expired',
        message: 'This file is not available. It may have expired or been deleted.',
        buttonUrl: '',
        buttonText: '',
        showButton: false,
      })
    );
  }

  return res.download(meta.filePath, meta.originalName, async (error) => {
    if (!error) {
      return;
    }

    if (error.code === 'ENOENT') {
      await removeFile(id);
      if (!res.headersSent) {
        return res.status(404).send(
          renderSharePage({
            title: 'Link Expired',
            message: 'This file is not available. It may have expired or been deleted.',
            buttonUrl: '',
            buttonText: '',
            showButton: false,
          })
        );
      }
      return;
    }

    return next(error);
  });
});

// Backward compatibility for older links.
app.get('/files/:id', async (req, res) => {
  return res.redirect(302, `/share/${req.params.id}`);
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large (max 100MB)' });
    }
    return res.status(400).json({ error: error.message });
  }

  if (error) {
    return res.status(400).json({ error: error.message || 'Upload failed' });
  }

  return res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
