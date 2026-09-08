const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { WebSocketServer } = require('ws');
const spotifyHandler = require('./api/spotify');
const deezerHandler = require('./api/deezer');
const matchHandler = require('./api/match');
const MultiplayerManager = require('./server/multiplayer');

const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml'
};

const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);

    if (parsedUrl.pathname === '/api/spotify') {
        req.query = parsedUrl.query;
        res.status = (code) => {
            res.statusCode = code;
            return {
                json: (data) => {
                    res.setHeader('Content-Type', 'application/json; charset=utf-8');
                    res.end(JSON.stringify(data));
                },
                end: () => res.end()
            };
        };
        return spotifyHandler(req, res);
    }

    if (parsedUrl.pathname === '/api/deezer') {
        req.query = parsedUrl.query;
        res.status = (code) => {
            res.statusCode = code;
            return {
                json: (data) => {
                    res.setHeader('Content-Type', 'application/json; charset=utf-8');
                    res.end(JSON.stringify(data));
                },
                end: () => res.end()
            };
        };
        return deezerHandler(req, res);
    }

    if (parsedUrl.pathname === '/api/match') {
        req.query = parsedUrl.query;
        res.status = (code) => {
            res.statusCode = code;
            return {
                json: (data) => {
                    res.setHeader('Content-Type', 'application/json; charset=utf-8');
                    res.end(JSON.stringify(data));
                },
                end: () => res.end()
            };
        };
        return matchHandler(req, res);
    }

    let reqPath = parsedUrl.pathname;
    if (reqPath === '/') reqPath = '/index.html';
    if (reqPath === '/multiplayer') reqPath = '/multiplayer.html';
    let filePath = path.join(__dirname, reqPath);
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'text/plain';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Not Found');
            } else {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(`Server Error: ${err.code}`);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        }
    });
});

// Setup WebSocket server for multiplayer
const wss = new WebSocketServer({ server });
const multiplayerManager = new MultiplayerManager(wss);

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/ (WebSocket enabled for multiplayer)`);
});
