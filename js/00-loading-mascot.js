        // --- 0. LOADING SCREEN MASCOT (chroma-keyed video) ---
        // CURRENTLY UNUSED: the #loadingMascotVideo/#loadingMascotCanvas
        // elements were pulled from the loading screen pending a better
        // source clip, so this no-ops via the null check below. Left in
        // place, ready to reconnect once a replacement video is dropped in -
        // see the HTML comment near #loadingOverlay.
        // The mascot clip has a plain white studio background baked in. Rather
        // than re-export/re-encode it, we draw each frame to a canvas and key
        // out that background live: a pixel counts as background (and gets
        // faded to transparent) only if it's both bright AND neutral in color
        // (r/g/b close together) - checking color spread as well as brightness
        // is what keeps H.264 compression noise in that flat backdrop from
        // surviving as speckled pixels, without also eating into skin/hat/boot
        // tones, which have real color spread even where they're bright. A
        // light 3x3 blur on the alpha channel only (never touching RGB) mops
        // up whatever single-pixel noise is left so it doesn't sparkle/flicker
        // frame to frame.
        (function initLoadingMascot() {
            const video = document.getElementById('loadingMascotVideo');
            const canvas = document.getElementById('loadingMascotCanvas');
            if (!video || !canvas) return;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });

            video.addEventListener('loadedmetadata', () => {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
            });

            function drawFrame() {
                const w = canvas.width, h = canvas.height;
                if (video.readyState >= 2 && w) {
                    ctx.drawImage(video, 0, 0, w, h);
                    const frame = ctx.getImageData(0, 0, w, h);
                    const d = frame.data;
                    for (let i = 0; i < d.length; i += 4) {
                        const r = d[i], g = d[i + 1], b = d[i + 2];
                        const brightness = (r + g + b) / 3;
                        const spread = Math.max(r, g, b) - Math.min(r, g, b);
                        if (spread < 22 && brightness > 150) {
                            const t = Math.min(1, (brightness - 150) / 90);
                            d[i + 3] = Math.round(d[i + 3] * (1 - t));
                        }
                    }
                    const alphaIn = new Uint8ClampedArray(d.length / 4);
                    for (let p = 0, i = 3; i < d.length; i += 4, p++) alphaIn[p] = d[i];
                    for (let y = 0; y < h; y++) {
                        for (let x = 0; x < w; x++) {
                            const idx = y * w + x;
                            if (alphaIn[idx] === 255) continue; // opaque interior - skip, cheaper and avoids eroding solid areas
                            let sum = 0, count = 0;
                            for (let dy = -1; dy <= 1; dy++) {
                                const ny = y + dy;
                                if (ny < 0 || ny >= h) continue;
                                for (let dx = -1; dx <= 1; dx++) {
                                    const nx = x + dx;
                                    if (nx < 0 || nx >= w) continue;
                                    sum += alphaIn[ny * w + nx];
                                    count++;
                                }
                            }
                            d[idx * 4 + 3] = Math.round(sum / count);
                        }
                    }
                    ctx.putImageData(frame, 0, 0);
                }
                requestAnimationFrame(drawFrame);
            }
            requestAnimationFrame(drawFrame);
        })();

