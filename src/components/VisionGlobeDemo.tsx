import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import {
  computeHandTilt,
  computePinch,
  countExtendedFingers,
  type HandLandmarks,
} from '../lib/handMath'
import { ExpSmoother } from '../lib/smoother'

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string }

const WASM_BASE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm'

export function VisionGlobeDemo() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const overlayRef = useRef<HTMLCanvasElement | null>(null)

  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [cameraOn, setCameraOn] = useState(false)

  const [tiltDeg, setTiltDeg] = useState({ x: 0, y: 0 })
  const [pinch, setPinch] = useState(0)

  const smoothTiltX = useMemo(() => new ExpSmoother(0.18), [])
  const smoothTiltY = useMemo(() => new ExpSmoother(0.18), [])
  const smoothPinch = useMemo(() => new ExpSmoother(0.12), [])

  const three = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    globe: THREE.Mesh
    clouds: THREE.Mesh
    glow: THREE.Mesh
    burstGroup: THREE.Group
    frameId: number | null
    resizeObserver: ResizeObserver
  } | null>(null)

  const mp = useRef<{
    handLandmarker: HandLandmarker
    rafId: number | null
    lastVideoTime: number
  } | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    })
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.1
    el.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = null

    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100)
    camera.position.set(0, 0, 3.2)

    const ambient = new THREE.AmbientLight(0xffffff, 0.65)
    scene.add(ambient)
    const key = new THREE.DirectionalLight(0xffffff, 1.3)
    key.position.set(3, 2, 3)
    scene.add(key)
    const rim = new THREE.DirectionalLight(0x8b5cf6, 0.6)
    rim.position.set(-3, 1.5, -2.5)
    scene.add(rim)

    const tex = new THREE.TextureLoader()
    const day = tex.load('/textures/earth_day_2048.jpg')
    day.colorSpace = THREE.SRGBColorSpace
    const bump = tex.load('/textures/earth_bump_2048.jpg')
    const spec = tex.load('/textures/earth_spec_2048.jpg')

    const globeGeo = new THREE.SphereGeometry(1, 128, 128)
    const globeMat = new THREE.MeshPhongMaterial({
      map: day,
      bumpMap: bump,
      bumpScale: 0.04,
      specularMap: spec,
      specular: new THREE.Color('#b7d7ff'),
      shininess: 12,
    })
    const globe = new THREE.Mesh(globeGeo, globeMat)
    scene.add(globe)

    const cloudTex = tex.load('/textures/earth_clouds_1024.png')
    cloudTex.colorSpace = THREE.SRGBColorSpace
    const clouds = new THREE.Mesh(
      new THREE.SphereGeometry(1.01, 128, 128),
      new THREE.MeshPhongMaterial({
        map: cloudTex,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      }),
    )
    globe.add(clouds)

    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(1.12, 64, 64),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color('#a78bfa'),
        transparent: true,
        opacity: 0.065,
        side: THREE.BackSide,
      }),
    )
    scene.add(glow)

    const burstGroup = new THREE.Group()
    burstGroup.visible = false
    scene.add(burstGroup)
    const ringMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#93c5fd'),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.12, 1.18, 128),
        ringMat.clone(),
      )
      ring.rotation.x = Math.PI / 2
      burstGroup.add(ring)
    }

    const stars = makeStarfield()
    scene.add(stars)

    const resize = () => {
      const r = el.getBoundingClientRect()
      const w = Math.max(1, Math.floor(r.width))
      const h = Math.max(1, Math.floor(r.height))
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }

    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(el)
    resize()

    let t0 = performance.now()
    let burstT = 0
    const tick = (t: number) => {
      const dt = Math.min(0.05, (t - t0) / 1000)
      t0 = t

      globe.rotation.y += dt * 0.22
      clouds.rotation.y += dt * 0.32
      stars.rotation.y += dt * 0.02

      // burst animation
      if (burstGroup.visible) {
        burstT += dt
        const k = Math.min(1, burstT / 0.55)
        const e = 1 - Math.pow(1 - k, 3)
        burstGroup.scale.setScalar(1 + e * 0.65)
        for (let i = 0; i < burstGroup.children.length; i++) {
          const m = (burstGroup.children[i] as THREE.Mesh)
            .material as THREE.MeshBasicMaterial
          m.opacity = (1 - k) * (0.22 - i * 0.04)
          burstGroup.children[i].rotation.z += dt * (0.7 + i * 0.35)
        }
        if (k >= 1) {
          burstGroup.visible = false
          burstT = 0
          burstGroup.scale.setScalar(1)
          for (const child of burstGroup.children) {
            const m = (child as THREE.Mesh).material as THREE.MeshBasicMaterial
            m.opacity = 0
          }
        }
      }

      renderer.render(scene, camera)
      const frameId = requestAnimationFrame(tick)
      if (three.current) three.current.frameId = frameId
    }
    const frameId = requestAnimationFrame(tick)

    three.current = {
      renderer,
      scene,
      camera,
      globe,
      clouds,
      glow,
      burstGroup,
      frameId,
      resizeObserver,
    }

    return () => {
      if (three.current?.frameId) cancelAnimationFrame(three.current.frameId)
      resizeObserver.disconnect()
      renderer.dispose()
      globeGeo.dispose()
      globeMat.dispose()
      glow.geometry.dispose()
      ;(glow.material as THREE.Material).dispose()
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose?.()
        if (mesh.material) {
          const m = mesh.material as THREE.Material | THREE.Material[]
          if (Array.isArray(m)) m.forEach((mm) => mm.dispose())
          else m.dispose()
        }
      })
      renderer.domElement.remove()
      three.current = null
    }
  }, [])

  useEffect(() => {
    if (!cameraOn) return

    let stopped = false

    async function start() {
      try {
        setStatus({ kind: 'loading' })

        const video = videoRef.current
        const overlay = overlayRef.current
        if (!video || !overlay) throw new Error('Video elements not ready')

        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        })
        if (stopped) return
        video.srcObject = stream
        await video.play()

        const vision = await FilesetResolver.forVisionTasks(WASM_BASE)
        if (stopped) return

        const handLandmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          },
          runningMode: 'VIDEO',
          numHands: 1,
        })

        mp.current = { handLandmarker, rafId: null, lastVideoTime: -1 }
        setStatus({ kind: 'ready' })

        const ctx = overlay.getContext('2d')
        if (!ctx) throw new Error('2D canvas not available')

        const loop = () => {
          if (stopped) return
          const mpState = mp.current
          const threeState = three.current
          const v = videoRef.current
          const c = overlayRef.current
          if (!mpState || !threeState || !v || !c) return

          const vw = v.videoWidth || 0
          const vh = v.videoHeight || 0
          if (vw > 0 && vh > 0) {
            if (c.width !== vw || c.height !== vh) {
              c.width = vw
              c.height = vh
            }

            if (mpState.lastVideoTime !== v.currentTime) {
              mpState.lastVideoTime = v.currentTime
              const res = mpState.handLandmarker.detectForVideo(v, performance.now())
              const lms = (res.landmarks?.[0] ?? null) as HandLandmarks | null

              ctx.clearRect(0, 0, c.width, c.height)
              if (lms) drawLandmarks(ctx, lms, c.width, c.height)

              if (lms) {
                const tilt = computeHandTilt(lms)
                const pinchRaw = computePinch(lms)
                const fingers = countExtendedFingers(lms)

                const tx = smoothTiltX.next(tilt.xDeg)
                const ty = smoothTiltY.next(tilt.yDeg)
                const p = smoothPinch.next(pinchRaw)

                setTiltDeg({ x: tx, y: ty })
                setPinch(p)

                const rotX = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(tx, -22, 22))
                const rotY = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(ty, -30, 30))
                threeState.globe.rotation.x = THREE.MathUtils.lerp(
                  threeState.globe.rotation.x,
                  rotX,
                  0.25,
                )
                // If only 1 finger is extended, treat it like a "precision steer"
                const steerGain = fingers <= 1 ? 0.055 : 0.028
                threeState.globe.rotation.y += rotY * steerGain

                const s = 1 + THREE.MathUtils.clamp(p, 0, 1) * 0.85
                const eased = easeOutCubic(s)
                threeState.globe.scale.setScalar(eased)
                threeState.glow.scale.setScalar(1 + (eased - 1) * 1.25)
                ;(threeState.glow.material as THREE.MeshBasicMaterial).opacity =
                  0.08 + (eased - 1) * 0.22

                // Open palm burst (4-5 extended fingers)
                if (fingers >= 4 && !threeState.burstGroup.visible) {
                  threeState.burstGroup.visible = true
                  for (const child of threeState.burstGroup.children) {
                    const m = (child as THREE.Mesh).material as THREE.MeshBasicMaterial
                    m.opacity = 0.18
                  }
                }
              }
            }
          }

          mpState.rafId = requestAnimationFrame(loop)
        }
        loop()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setStatus({ kind: 'error', message: msg })
      }
    }

    void start()

    return () => {
      stopped = true
      const mpState = mp.current
      if (mpState?.rafId) cancelAnimationFrame(mpState.rafId)
      mp.current = null

      const v = videoRef.current
      const stream = v?.srcObject as MediaStream | null
      stream?.getTracks()?.forEach((t) => t.stop())
      if (v) v.srcObject = null
    }
  }, [cameraOn, smoothPinch, smoothTiltX, smoothTiltY])

  return (
    <div className="demoGrid">
      <section className="panel">
        <div className="panelHeader">
          <div>
            <div className="panelTitle">Hand Input</div>
            <div className="panelSub">
              Tilt your hand to steer. Pinch to expand the globe.
            </div>
          </div>
          <button
            className="btn"
            onClick={() => setCameraOn((v) => !v)}
            aria-pressed={cameraOn}
          >
            {cameraOn ? 'Stop camera' : 'Start camera'}
          </button>
        </div>

        <div className="cameraStage">
          <video ref={videoRef} className="video" playsInline muted />
          <canvas ref={overlayRef} className="overlay" />
          <div className="cameraChrome" />
          <div className="statusPill">
            {status.kind === 'idle' && 'Idle'}
            {status.kind === 'loading' && 'Loading hand model…'}
            {status.kind === 'ready' && 'Tracking'}
            {status.kind === 'error' && `Error: ${status.message}`}
          </div>
        </div>

        <div className="readout">
          <div className="readoutItem">
            <div className="readoutLabel">Tilt X</div>
            <div className="readoutValue">{tiltDeg.x.toFixed(1)}°</div>
          </div>
          <div className="readoutItem">
            <div className="readoutLabel">Tilt Y</div>
            <div className="readoutValue">{tiltDeg.y.toFixed(1)}°</div>
          </div>
          <div className="readoutItem">
            <div className="readoutLabel">Pinch</div>
            <div className="readoutValue">{pinch.toFixed(2)}</div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <div className="panelTitle">Globe</div>
            <div className="panelSub">Three.js scene driven by your hand.</div>
          </div>
        </div>
        <div className="globeStage" ref={containerRef} />
      </section>
    </div>
  )
}

function easeOutCubic(x: number) {
  const t = THREE.MathUtils.clamp(x, 0.85, 1.85)
  const u = (t - 0.85) / (1.85 - 0.85)
  return 0.85 + (1 - Math.pow(1 - u, 3)) * (1.85 - 0.85)
}

function drawLandmarks(
  ctx: CanvasRenderingContext2D,
  lms: HandLandmarks,
  w: number,
  h: number,
) {
  ctx.save()
  ctx.lineWidth = 2
  ctx.strokeStyle = 'rgba(96,165,250,0.6)'
  ctx.fillStyle = 'rgba(167,139,250,0.8)'

  const pts = lms.map((p) => ({ x: p.x * w, y: p.y * h }))

  const fingers = [
    [0, 1, 2, 3, 4],
    [0, 5, 6, 7, 8],
    [0, 9, 10, 11, 12],
    [0, 13, 14, 15, 16],
    [0, 17, 18, 19, 20],
  ]
  for (const chain of fingers) {
    ctx.beginPath()
    for (let i = 0; i < chain.length; i++) {
      const p = pts[chain[i]]
      if (!p) continue
      if (i === 0) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
    }
    ctx.stroke()
  }

  for (const p of pts) {
    ctx.beginPath()
    ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.restore()
}

function makeStarfield() {
  const g = new THREE.BufferGeometry()
  const count = 900
  const pos = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const r = 22 * Math.random() + 8
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    const x = r * Math.sin(phi) * Math.cos(theta)
    const y = r * Math.sin(phi) * Math.sin(theta)
    const z = r * Math.cos(phi)
    pos[i * 3 + 0] = x
    pos[i * 3 + 1] = y
    pos[i * 3 + 2] = z
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  const m = new THREE.PointsMaterial({
    size: 0.035,
    color: new THREE.Color('#e9d5ff'),
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  })
  return new THREE.Points(g, m)
}

