const https = require('https');
const http = require('http');

function fetchHttp(url, options = {}) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json,text/html,*/*',
                'Accept-Language': 'fr,en-US;q=0.9,en;q=0.8',
                ...options.headers
            }
        }, (res) => {
            // Handle redirects (e.g. deezer.page.link shortlinks)
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchHttp(res.headers.location, options).then(resolve).catch(reject);
            }

            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        resolve(data);
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 100)}`));
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('Request timed out'));
        });
    });
}

async function extractDeezerPlaylistId(input, maxRedirects = 8) {
    if (!input) return '';
    let currentUrl = input.trim();

    // Direct numeric ID
    if (/^\d+$/.test(currentUrl)) {
        return currentUrl;
    }

    // Check if playlist ID is directly in the URL or query params
    const matchDirect = decodeURIComponent(currentUrl).match(/\/playlist\/(\d+)/) || decodeURIComponent(currentUrl).match(/playlist-(\d+)/);
    if (matchDirect) {
        return matchDirect[1];
    }

    // Follow redirects for shortlinks / link.deezer.com / deezer.page.link
    for (let i = 0; i < maxRedirects; i++) {
        const match = decodeURIComponent(currentUrl).match(/\/playlist\/(\d+)/) || decodeURIComponent(currentUrl).match(/playlist-(\d+)/);
        if (match) {
            return match[1];
        }

        try {
            const nextUrl = await new Promise((resolve, reject) => {
                const client = currentUrl.startsWith('https') ? https : http;
                const req = client.get(currentUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                }, (res) => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        resolve(res.headers.location);
                    } else {
                        let body = '';
                        res.on('data', c => body += c);
                        res.on('end', () => {
                            const bodyMatch = body.match(/\/playlist\/(\d+)/) || body.match(/playlist-(\d+)/) || body.match(/deezer:\/\/www\.deezer\.com\/playlist\/(\d+)/);
                            if (bodyMatch) {
                                resolve('https://www.deezer.com/playlist/' + bodyMatch[1]);
                            } else {
                                resolve(null);
                            }
                        });
                    }
                });
                req.on('error', reject);
                req.setTimeout(6000, () => { req.destroy(); resolve(null); });
            });

            if (!nextUrl) break;
            currentUrl = nextUrl.startsWith('http') ? nextUrl : new URL(nextUrl, currentUrl).href;
        } catch (e) {
            console.warn('Deezer redirect resolution error:', e.message);
            break;
        }
    }

    const finalMatch = decodeURIComponent(currentUrl).match(/\/playlist\/(\d+)/) || decodeURIComponent(currentUrl).match(/playlist-(\d+)/);
    return finalMatch ? finalMatch[1] : '';
}

function cleanSongTitle(title) {
    if (!title) return 'Unknown Title';
    let cleaned = title
        .replace(/\((feat\.|ft\.|featuring).*?\)/gi, '')
        .replace(/\[(feat\.|ft\.|featuring).*?\]/gi, '')
        .replace(/\(Official Video.*?\)/gi, '')
        .replace(/\[Official Video.*?\]/gi, '')
        .replace(/\(Official Music Video.*?\)/gi, '')
        .replace(/\[Official Music Video.*?\]/gi, '')
        .replace(/\(Official Audio.*?\)/gi, '')
        .replace(/\[Official Audio.*?\]/gi, '')
        .replace(/\(Audio Officiel.*?\)/gi, '')
        .replace(/\[Audio Officiel.*?\]/gi, '')
        .replace(/\(Clip Officiel.*?\)/gi, '')
        .replace(/\[Clip Officiel.*?\]/gi, '')
        .replace(/\(Lyrics.*?\)/gi, '')
        .replace(/\[Lyrics.*?\]/gi, '')
        .replace(/\(Paroles.*?\)/gi, '')
        .replace(/\[Paroles.*?\]/gi, '')
        .replace(/\(Lyric Video.*?\)/gi, '')
        .replace(/\[Lyric Video.*?\]/gi, '')
        .replace(/\bft\.\s+.*$/gi, '')
        .replace(/\bfeat\.\s+.*$/gi, '')
        .replace(/\bfeaturing\s+.*$/gi, '')
        .trim();

    if (!cleaned) {
        cleaned = title.replace(/[\[\]\(\)]/g, '').trim();
    }
    return cleaned || title;
}

module.exports = async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const { url, id, playlistId: queryPlaylistId } = req.query;
    const rawInput = url || id || queryPlaylistId;
    const playlistId = await extractDeezerPlaylistId(rawInput);

    if (!playlistId || !/^\d+$/.test(playlistId)) {
        return res.status(400).json({
            error: 'Invalid or missing Deezer playlist URL or numeric ID.'
        });
    }

    try {
        const apiUrl = `https://api.deezer.com/playlist/${encodeURIComponent(playlistId)}?limit=100`;
        const data = await fetchHttp(apiUrl);

        if (data.error) {
            return res.status(404).json({
                error: data.error.message || 'Deezer playlist not found or private.'
            });
        }

        const playlistName = data.title || 'Deezer Playlist';
        const tracksData = (data.tracks && data.tracks.data) ? data.tracks.data : [];

        const songs = tracksData.map(item => {
            const rawTitle = item.title_short || item.title || 'Unknown Title';
            const fullTitle = item.title || rawTitle;
            const rawArtist = (item.artist && item.artist.name) ? item.artist.name : 'Unknown Artist';

            return {
                id: null, // to be matched with YouTube audio on demand if needed
                title: cleanSongTitle(rawTitle),
                artist: rawArtist.trim(),
                original_title: fullTitle,
                audioPreviewUrl: item.preview || null,
                deezerId: item.id || null,
                source: 'deezer'
            };
        }).filter(s => s.title && s.artist);

        if (songs.length === 0) {
            return res.status(404).json({
                error: 'No songs found in this Deezer playlist. Make sure the playlist is public.'
            });
        }

        return res.status(200).json({
            success: true,
            id: playlistId,
            name: playlistName,
            source: 'deezer',
            songs: songs
        });

    } catch (error) {
        console.error('Deezer fetch error:', error);
        return res.status(500).json({
            error: `Failed to fetch Deezer playlist: ${error.message}`
        });
    }
};
