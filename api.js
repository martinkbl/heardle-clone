// Mock SoundCloud API for Heardle game interface
// This allows the game UI to load without actual audio functionality

window.SC = {
    Widget: function(elementId) {
        console.log('Mock SoundCloud Widget created for:', elementId);
        
        const widget = {
            // Mock widget methods that the game expects
            bind: function(event, callback) {
                console.log('Mock bind event:', event);
                // Store callbacks for later triggering
                this._callbacks = this._callbacks || {};
                this._callbacks[event] = callback;
                
                // Simulate ready state after a short delay
                if (event === 'ready' || event === SC.Widget.Events.READY) {
                    setTimeout(() => {
                        console.log('Triggering READY event');
                        callback();
                    }, 100);
                }
                return this;
            },
            
            getCurrentSound: function(callback) {
                console.log('Mock getCurrentSound called');
                // Return mock song data that the game expects
                const mockSong = {
                    policy: 'ALLOW', // Not BLOCK to avoid geo-blocking
                    artwork_url: '',
                    duration: 16000, // 16 seconds in milliseconds
                    genre: 'Pop',
                    release_date: '2023',
                    id: 1,
                    title: 'Mock Song Title',
                    artist: 'Mock Artist'
                };
                setTimeout(() => callback(mockSong), 50);
                return this;
            },
            
            play: function() {
                console.log('Mock play');
                // Trigger play event if callback exists
                if (this._callbacks && this._callbacks[SC.Widget.Events.PLAY]) {
                    this._callbacks[SC.Widget.Events.PLAY]();
                }
                return this;
            },
            
            pause: function() {
                console.log('Mock pause');
                // Trigger pause event if callback exists
                if (this._callbacks && this._callbacks[SC.Widget.Events.PAUSE]) {
                    this._callbacks[SC.Widget.Events.PAUSE]();
                }
                return this;
            },
            
            toggle: function() {
                console.log('Mock toggle');
                return this;
            },
            
            seekTo: function(position) {
                console.log('Mock seekTo:', position);
                return this;
            },
            
            setVolume: function(volume) {
                console.log('Mock setVolume:', volume);
                return this;
            },
            
            getDuration: function(callback) {
                console.log('Mock getDuration');
                // Return a mock duration (16 seconds as shown in screenshot)
                setTimeout(() => callback(16000), 10);
                return this;
            },
            
            getPosition: function(callback) {
                console.log('Mock getPosition');
                // Return current position (starts at 0)
                setTimeout(() => callback(0), 10);
                return this;
            },
            
            isPaused: function(callback) {
                console.log('Mock isPaused');
                setTimeout(() => callback(true), 10);
                return this;
            },
            
            load: function(url, options) {
                console.log('Mock load:', url, options);
                // Simulate loading complete and trigger ready event after load
                setTimeout(() => {
                    if (this._callbacks && this._callbacks[SC.Widget.Events.READY]) {
                        this._callbacks[SC.Widget.Events.READY]();
                    }
                }, 200);
                return this;
            },
            
            _callbacks: {}
        };
        
        return widget;
    }
};

// Add the Events constants that the game expects
SC.Widget.Events = {
    READY: 'ready',
    PLAY: 'play', 
    PAUSE: 'pause',
    PLAY_PROGRESS: 'playProgress',
    LOAD_PROGRESS: 'loadProgress',
    FINISH: 'finish',
    SEEK: 'seek'
};

// Mock initialization complete
console.log('Mock SoundCloud API with Events and getCurrentSound loaded');

// Trigger any initialization callbacks
if (window.onSCLoad) {
    window.onSCLoad();
} 