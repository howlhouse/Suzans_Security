self.addEventListener('install', (e) => {
    console.log('Service Worker: Installed');
});

self.addEventListener('fetch', (e) => {
    // Allows the app to bypass basic fetch requirements for PWA installation
});