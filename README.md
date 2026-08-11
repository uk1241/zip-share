# ZIP Share Service

A simple Node.js app to upload ZIP files and share a temporary download link.

## Features

- Upload only `.zip` files
- Returns a shareable download link
- Automatically deletes uploaded file after 25 minutes using scheduled cleanup
- No authentication and no authorization

## Run locally

1. Install dependencies:

   npm install

2. Start the server:

   npm start

3. Open:

   http://localhost:3000

## API

### Upload

- **POST** `/upload`
- `multipart/form-data` with field name: `file`

Response:

```json
{
  "message": "Upload successful",
   "shareUrl": "http://localhost:3000/share/<id>",
   "downloadUrl": "http://localhost:3000/share/<id>",
  "expiresAt": "2026-08-11T12:34:56.000Z"
}
```

### Download

- **GET** `/share/:id`
- Opens a share page with message + download button
- If file is expired/deleted, shows an expired message

## Deploy on Render

1. Push this project to GitHub.
2. In Render, create a new **Web Service** from the repo.
3. Render auto-detects [render.yaml](render.yaml). If prompted, use:
    - Build Command: `npm install`
    - Start Command: `npm start`
4. In Render environment variables, set:
    - `BASE_URL` = your Render public URL (example: `https://zip-share-service.onrender.com`)
5. Deploy.

Health check endpoint:

- `GET /health`

Notes for Render:

- Uploaded files are local to the running instance and temporary by design.
- After a restart/redeploy, existing share links may stop working.
- Keep this service as a single instance to avoid in-memory metadata mismatch across instances.

## Deploy notes (manual)

- Set `BASE_URL` in your server environment so returned links use your public domain.
- Example:

  BASE_URL=https://your-domain.com npm start
