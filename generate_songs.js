require('dotenv').config();
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Configuration
const API_KEY = process.env.YOUTUBE_API_KEY || '';
const PLAYLISTS_CONFIG = process.env.YOUTUBE_PLAYLISTS || '';

function cleanPlaylistId(rawId) {
    let id = (rawId || '').trim();
    if (id.includes('list=')) {
        id = id.split('list=')[1];
    }
    if (id.includes('&')) {
        id = id.split('&')[0];
    }
    if (id.includes('?')) {
        id = id.split('?')[0];
    }
    return id.trim();
}

// Parse playlists from configuration
const playlists = [];
if (PLAYLISTS_CONFIG) {
    PLAYLISTS_CONFIG.split(',').forEach(item => {
        const [id, ...nameParts] = item.split(':');
        const name = nameParts.join(':').trim();
        if (id && name) {
            playlists.push({ id: cleanPlaylistId(id), name: name });
        }
    });
} else if (process.env.YOUTUBE_PLAYLIST_ID) {
    // Fallback to single playlist
    playlists.push({ id: cleanPlaylistId(process.env.YOUTUBE_PLAYLIST_ID), name: 'Default' });
}

if (playlists.length === 0) {
    console.error('❌ Error: No playlists configured. Please set YOUTUBE_PLAYLISTS or YOUTUBE_PLAYLIST_ID in .env file.');
    process.exit(1);
}

const YOUTUBE_API_URL = 'https://www.googleapis.com/youtube/v3/playlistItems';

function cleanSongMetadata(title, rawArtist) {
    let cleanTitle = (title || '').trim();
    let artist = (rawArtist || 'Unknown Artist').trim();

    // Try to parse "Artist - Title" format common in music videos
    if (cleanTitle.includes(' - ')) {
        const parts = cleanTitle.split(' - ');
        artist = parts[0].trim();
        cleanTitle = parts.slice(1).join(' - ').trim();
    }

    // Remove common noise from titles
    cleanTitle = cleanTitle
        .replace(/[\(\[\{].*?[\)\]\}]/g, '') // Remove (...) [...] {...}
        .replace(/Official Video/gi, '')
        .replace(/Official Audio/gi, '')
        .replace(/Lyrics/gi, '')
        .replace(/ft\./gi, '')
        .replace(/feat\./gi, '')
        .replace(/,/g, '') // remove commas
        .trim();

    return { title: cleanTitle, artist };
}

// Method 1: Fetch via official YouTube Data API v3
async function fetchViaApi(playlistId, playlistName) {
    if (!API_KEY) return null;

    let allItems = [];
    let nextPageToken = '';
    let pageCount = 0;

    try {
        do {
            pageCount++;
            console.log(`   [API] Fetching page ${pageCount} for "${playlistName}"...`);

            const response = await axios.get(YOUTUBE_API_URL, {
                params: {
                    part: 'snippet,contentDetails',
                    maxResults: 50,
                    playlistId: playlistId,
                    key: API_KEY,
                    pageToken: nextPageToken
                }
            });

            const items = response.data.items;
            if (!items || items.length === 0) {
                break;
            }

            const cleanItems = items.map(item => {
                const snippet = item.snippet;
                const videoId = item.contentDetails?.videoId || snippet?.resourceId?.videoId;
                const rawTitle = snippet.title;
                const rawArtist = snippet.videoOwnerChannelTitle || "Unknown Artist";
                const cleaned = cleanSongMetadata(rawTitle, rawArtist);

                return {
                    id: videoId,
                    title: cleaned.title,
                    artist: cleaned.artist,
                    original_title: rawTitle,
                    thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
                };
            }).filter(song => song.id && song.title && song.title !== 'Private video' && song.title !== 'Deleted video');

            allItems = allItems.concat(cleanItems);
            nextPageToken = response.data.nextPageToken;

        } while (nextPageToken);

        return allItems;
    } catch (error) {
        console.warn(`   ⚠️ YouTube Data API not available for "${playlistName}" (${error.message}). Falling back to web extraction...`);
        return null;
    }
}

// Method 2: Fetch via Web Scraper fallback (supports YouTube Music RDCLAK... and unrestricted access)
function fetchWebHtml(url) {
    return new Promise((resolve, reject) => {
        https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

async function fetchViaWeb(playlistId, playlistName) {
    try {
        console.log(`   [Web] Fetching web playlist data for "${playlistName}" (${playlistId})...`);
        const url = `https://www.youtube.com/playlist?list=${playlistId}`;
        const html = await fetchWebHtml(url);

        const idx = html.indexOf('ytInitialData');
        if (idx === -1) {
            console.error(`   ❌ Could not find playlist data on page for "${playlistName}".`);
            return [];
        }

        const jsonStart = html.indexOf('{', idx);
        const scriptEnd = html.indexOf(';</script>', jsonStart);
        const jsonStr = html.substring(jsonStart, scriptEnd);
        const data = JSON.parse(jsonStr);

        const songs = [];

        function traverse(obj) {
            if (!obj || typeof obj !== 'object') return;

            if (obj.lockupViewModel && obj.lockupViewModel.contentId) {
                const lockup = obj.lockupViewModel;
                const videoId = lockup.contentId;
                const title = lockup.metadata?.lockupMetadataViewModel?.title?.content || '';

                let artist = 'Unknown Artist';
                const metadataRows = lockup.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows;
                if (metadataRows && metadataRows.length > 0) {
                    const parts = metadataRows[0]?.metadataParts;
                    if (parts && parts.length > 0) {
                        artist = parts[0]?.text?.content || artist;
                    }
                }

                const thumbnails = lockup.image?.imageModel?.image?.sources;
                const thumbnail = thumbnails && thumbnails.length > 0
                    ? thumbnails[thumbnails.length - 1].url
                    : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

                if (videoId && title && title !== 'Private video' && title !== 'Deleted video') {
                    const cleaned = cleanSongMetadata(title, artist);
                    songs.push({
                        id: videoId,
                        title: cleaned.title,
                        artist: cleaned.artist,
                        original_title: title,
                        thumbnail: thumbnail
                    });
                }
            }

            if (obj.playlistVideoRenderer) {
                const pvr = obj.playlistVideoRenderer;
                const videoId = pvr.videoId;
                const title = pvr.title?.runs?.[0]?.text || pvr.title?.simpleText || '';
                const artist = pvr.shortBylineText?.runs?.[0]?.text || 'Unknown Artist';
                const thumbnail = pvr.thumbnail?.thumbnails?.slice(-1)[0]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

                if (videoId && title && title !== 'Private video' && title !== 'Deleted video') {
                    const cleaned = cleanSongMetadata(title, artist);
                    songs.push({
                        id: videoId,
                        title: cleaned.title,
                        artist: cleaned.artist,
                        original_title: title,
                        thumbnail: thumbnail
                    });
                }
            }

            for (const key of Object.keys(obj)) {
                traverse(obj[key]);
            }
        }

        traverse(data);

        // Deduplicate songs by ID
        const seen = new Set();
        const deduplicated = songs.filter(s => {
            if (seen.has(s.id)) return false;
            seen.add(s.id);
            return true;
        });

        console.log(`   ✅ Success! Extracted ${deduplicated.length} songs for "${playlistName}".`);
        return deduplicated;
    } catch (err) {
        console.error(`   ❌ Error scraping playlist "${playlistName}":`, err.message);
        return [];
    }
}

async function fetchPlaylistItems(playlistId, playlistName) {
    let items = await fetchViaApi(playlistId, playlistName);
    if (!items || items.length === 0) {
        items = await fetchViaWeb(playlistId, playlistName);
    }
    return items || [];
}

async function generateAllPlaylists() {
    const outputData = {};

    for (const playlist of playlists) {
        console.log(`\n🎵 Starting fetch for Playlist: "${playlist.name}" (${playlist.id})`);
        const songs = await fetchPlaylistItems(playlist.id, playlist.name);
        
        if (songs.length > 0) {
            const key = playlist.name
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/[^a-z0-9]+/g, '_')
                .replace(/^_+|_+$/g, '');

            outputData[key] = {
                name: playlist.name,
                songs: songs
            };
        }
    }

    if (Object.keys(outputData).length === 0) {
        console.error('❌ Error: No songs could be fetched from any of the configured playlists.');
        process.exit(1);
    }

    // Save to playlists.json
    fs.writeFileSync('playlists.json', JSON.stringify(outputData, null, 2));
    console.log(`💾 Saved to playlists.json`);

    // Save fallback JS file for file:// protocol compatibility
    const jsContent = `// Fallback playlists for file:// compatibility\nwindow.HEARDLE_PLAYLISTS = ${JSON.stringify(outputData, null, 2)};\n`;
    fs.writeFileSync('playlists.js', jsContent);
    console.log(`💾 Saved to playlists.js`);

    // Backwards-compatible fallback: save the first playlist to songs.json and songs.js
    const firstKey = Object.keys(outputData)[0];
    if (firstKey) {
        const fallbackSongs = outputData[firstKey].songs;
        fs.writeFileSync('songs.json', JSON.stringify(fallbackSongs, null, 2));
        fs.writeFileSync('songs.js', `// Fallback song list for file:// compatibility\nwindow.HEARDLE_SONGS = ${JSON.stringify(fallbackSongs, null, 2)};\n`);
        console.log(`💾 Backwards-compatible songs.json and songs.js updated with playlist "${outputData[firstKey].name}"`);
    }

    console.log('\n🎉 Playlist generation complete!');
}

generateAllPlaylists();
