require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Configuration
const API_KEY = process.env.YOUTUBE_API_KEY; 
const PLAYLISTS_CONFIG = process.env.YOUTUBE_PLAYLISTS || '';

if (!API_KEY) {
    console.error('❌ Error: YOUTUBE_API_KEY is missing. Please set it in .env file.');
    process.exit(1);
}

// Parse playlists from configuration
const playlists = [];
if (PLAYLISTS_CONFIG) {
    PLAYLISTS_CONFIG.split(',').forEach(item => {
        const [id, name] = item.split(':');
        if (id && name) {
            playlists.push({ id: id.trim(), name: name.trim() });
        }
    });
} else if (process.env.YOUTUBE_PLAYLIST_ID) {
    // Fallback to single playlist
    playlists.push({ id: process.env.YOUTUBE_PLAYLIST_ID.trim(), name: 'Default' });
}

if (playlists.length === 0) {
    console.error('❌ Error: No playlists configured. Please set YOUTUBE_PLAYLISTS or YOUTUBE_PLAYLIST_ID in .env file.');
    process.exit(1);
}

const YOUTUBE_API_URL = 'https://www.googleapis.com/youtube/v3/playlistItems';

async function fetchPlaylistItems(playlistId, playlistName) {
    let allItems = [];
    let nextPageToken = '';
    let pageCount = 0;

    try {
        do {
            pageCount++;
            console.log(`   Fetching page ${pageCount} for "${playlistName}"...`);

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
                console.log('   No more items found.');
                break;
            }

            // Extract relevant data
            const cleanItems = items.map(item => {
                const snippet = item.snippet;
                const videoId = item.contentDetails.videoId;
                
                // Basic cleanup of titles to make them harder to guess
                let title = snippet.title;
                let artist = snippet.videoOwnerChannelTitle || "Unknown Artist";

                // Try to parse "Artist - Title" format common in music videos
                if (title.includes(' - ')) {
                    const parts = title.split(' - ');
                    artist = parts[0].trim();
                    title = parts.slice(1).join(' - ').trim();
                }

                // Remove common noise from titles
                title = title
                    .replace(/[\(\[\{].*?[\)\]\}]/g, '') // Remove (...) [...] {...}
                    .replace(/Official Video/gi, '')
                    .replace(/Official Audio/gi, '')
                    .replace(/Lyrics/gi, '')
                    .replace(/ft\./gi, '')
                    .replace(/feat\./gi, '')
                    .replace(/,/g, '') // remove commas
                    .trim();

                return {
                    id: videoId,
                    title: title,
                    artist: artist,
                    original_title: snippet.title, // Keep original just in case
                    thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url
                };
            }).filter(song => song.title !== 'Private video' && song.title !== 'Deleted video');

            allItems = allItems.concat(cleanItems);
            nextPageToken = response.data.nextPageToken;

        } while (nextPageToken);

        console.log(`   ✅ Success! Fetched ${allItems.length} songs for "${playlistName}".`);
        return allItems;

    } catch (error) {
        console.error(`   ❌ Error fetching playlist "${playlistName}":`, error.message);
        if (error.response) {
            console.error('   API Error Details:', error.response.data);
        }
        return [];
    }
}

async function generateAllPlaylists() {
    const outputData = {};

    for (const playlist of playlists) {
        console.log(`🎵 Starting fetch for Playlist: "${playlist.name}" (${playlist.id})`);
        const songs = await fetchPlaylistItems(playlist.id, playlist.name);
        
        if (songs.length > 0) {
            const key = playlist.name.toLowerCase().replace(/\s+/g, '_');
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
