const express = require('express');
const { exec } = require('child_process');
const app = express();
const port = process.env.PORT || 3000;

app.get('/get', (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).send({ error: 'Missing url parameter' });
  }

  // Use mweb client and add a 2‑second delay between requests
  const command = `yt-dlp --extractor-args youtube:player_client=mweb --sleep-requests 2 -g "${url}"`;

  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error: ${error}`);
      console.error(`stderr: ${stderr}`);
      return res.status(500).send({ error: error.message });
    }
    const directUrl = stdout.trim();
    if (!directUrl) {
      return res.status(500).send({ error: 'No URL returned' });
    }
    res.send({ url: directUrl });
  });
});

app.listen(port, () => {
  console.log(`Proxy server running on port ${port}`);
});
