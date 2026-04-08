# Vision Projects

Realtime computer-vision + graphics demos built to *wow*.

## Demo 1: Hand Tilt + Pinch Globe

- **Tilt** your hand to steer the globe.
- **Pinch** (thumb + index) to expand it with a glow burst.

Tech:

- **Hand tracking**: MediaPipe Tasks Vision `HandLandmarker`
- **Rendering**: Three.js
- **App**: Vite + React + TypeScript

## Run locally

From `vision-projects/`:

```bash
npm install
npm run dev
```

Then open the URL printed in the terminal and **allow camera access**.

## Notes

- Works best in **Chrome / Edge**.
- If the model download is blocked by network policy, we can vendor the `.task` model file locally and load it from `public/`.
