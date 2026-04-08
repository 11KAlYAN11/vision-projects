import { VisionGlobeDemo } from './components/VisionGlobeDemo'

export default function App() {
  return (
    <div className="appShell">
      <header className="appHeader">
        <div className="brand">
          <div className="brandMark" aria-hidden="true" />
          <div>
            <div className="brandTitle">Vision Projects</div>
            <div className="brandSub">Hand-tilt + pinch-expand globe (webcam)</div>
          </div>
        </div>
        <div className="headerHint">
          Allow camera access. Hold your hand up and pinch.
        </div>
      </header>

      <main className="appMain">
        <VisionGlobeDemo />
      </main>
    </div>
  )
}
