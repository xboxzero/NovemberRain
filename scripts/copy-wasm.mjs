// Copies the freshly built engine into public/ so Vite serves it next to the app.
import { copyFileSync, mkdirSync, statSync } from 'node:fs';

const src = 'engine/target/wasm32-unknown-unknown/release/engine.wasm';
mkdirSync('public', { recursive: true });
copyFileSync(src, 'public/engine.wasm');
console.log(`engine.wasm ${(statSync(src).size / 1024).toFixed(0)} kB -> public/`);
