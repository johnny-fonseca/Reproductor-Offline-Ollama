(function (window) {
    'use strict';

    var VP = window.VP;

    /* =====================================================================
       3. ESTILOS Y ANIMACIONES CSS
       ===================================================================== */
    var ESTILOS_BASE = `
/* Contenedor, posiciones y componentes visuales. */
.vp-mochi{
  position:absolute;
  z-index:40;
  display:none;
  pointer-events:none;
  font-family:inherit;
  --vp-mochi-ink:#3a2540;
  --vp-mochi-cheek:#f48ab8;
  --vp-mochi-bubble-bg:rgba(28,22,38,.94);
  --vp-mochi-bubble-fg:#fff;
  --vp-mochi-accent:#ffd36b;
  --vp-mochi-pink:#ffb3d6;
  --vp-mochi-lav:#d9b6ff;
  --vp-mochi-rim:rgba(255,255,255,.65);
  --vp-mochi-deep:rgba(58,32,90,.38);
}
.vp-mochi.is-visible{ display:block; }
.vp-mochi--bottom-right{ inset-block-end:88px; inset-inline-end:18px; }
.vp-mochi--bottom-left{ inset-block-end:88px; inset-inline-start:18px; }
.vp-mochi--top-right{ inset-block-start:18px; inset-inline-end:18px; }
.vp-mochi--top-left{ inset-block-start:18px; inset-inline-start:18px; }
.vp-mochi:focus-visible{
  outline:2px solid #c4a0ff;
  outline-offset:4px;
  border-radius:50%;
  filter:drop-shadow(0 0 6px rgba(196,160,255,.65));
}
.vp-mochi__wrap{
  position:relative;
  width:66px;
  height:62px;
  pointer-events:auto;
  cursor:pointer;
  filter:drop-shadow(0 8px 18px rgba(36,18,54,.28)) drop-shadow(0 2px 3px rgba(36,18,54,.18));
  transition:filter .3s cubic-bezier(.25,1,.5,1);
}
.vp-mochi__aura{
  position:absolute;
  inset:-11px;
  border-radius:50%;
  background:radial-gradient(ellipse at center, rgba(255,182,218,.24) 0 38%, rgba(217,182,255,.14) 0 58%, transparent 74%);
  opacity:.9;
  pointer-events:none;
  animation:vp-mochi-aura 3.6s cubic-bezier(.45,.05,.35,.95) infinite;
}
.vp-mochi__shadow{
  position:absolute;
  left:50%;
  bottom:-4px;
  width:42px;
  height:10px;
  transform:translateX(-50%);
  border-radius:50%;
  background:radial-gradient(ellipse at center, rgba(20,10,32,.32) 0 32%, rgba(20,10,32,.16) 0 60%, transparent 74%);
  filter:blur(.6px);
  opacity:.9;
  transition:transform .3s cubic-bezier(.34,1.56,.64,1), opacity .3s ease;
}
.vp-mochi:hover .vp-mochi__shadow{
  transform:translateX(-50%) scale(1.12);
  opacity:1;
}
.vp-mochi__body{
  position:relative;
  isolation:isolate;
  width:66px;
  height:60px;
  border:1px solid rgba(255,255,255,.8);
  border-radius:48% 48% 44% 44% / 52% 52% 40% 40%;
  background:
    radial-gradient(ellipse at 26% 16%, rgba(255,255,255,1) 0 7%, transparent 30%),
    radial-gradient(ellipse at 74% 90%, var(--vp-mochi-deep) 0 2%, transparent 46%),
    linear-gradient(148deg,#fbfaff 0%,#f0eafc 30%,#e2d8f3 58%,#c8bbe4 100%);
  box-shadow:
    inset 0 -7px 13px rgba(83,65,125,.16),
    inset 0 2px 0 var(--vp-mochi-rim),
    inset 3px 0 6px rgba(255,255,255,.35),
    0 8px 20px rgba(26,16,38,.3),
    0 0 0 1px rgba(255,255,255,.12);
  transform-origin:center bottom;
  transition:filter .3s ease, transform .24s cubic-bezier(.34,1.56,.64,1);
}
.vp-mochi__body:active{ transform:scale(.94,.96) translateY(2px); }
.vp-mochi__profile-accessory{ display:contents; }
.vp-mochi__shine{
  position:absolute;
  top:8px;
  left:12px;
  width:19px;
  height:9px;
  border-radius:50%;
  background:linear-gradient(120deg, rgba(255,255,255,.9), rgba(255,255,255,0) 80%);
  filter:blur(.3px);
  transform:rotate(-30deg);
  pointer-events:none;
}
.vp-mochi__ear{
  position:absolute;
  z-index:0;
  top:-10px;
  width:19px;
  height:24px;
  border:1px solid rgba(255,255,255,.8);
  border-radius:58% 58% 42% 42%;
  background:linear-gradient(148deg,#fbf9ff,#d3c6e9 62%,#bcaad6);
  box-shadow:inset 0 -3px 6px rgba(83,65,125,.15), inset 0 2px 0 rgba(255,255,255,.5);
  transform-origin:center bottom;
  pointer-events:none;
}
.vp-mochi__ear::after{
  content:"";
  position:absolute;
  inset:6px 4px 5px;
  border-radius:58% 58% 45% 45%;
  background:linear-gradient(178deg,#f3d9ea,#cf9fc9 55%,#b285ba);
  opacity:.85;
}
.vp-mochi__ear--left{ left:5px; transform:rotate(-18deg); z-index:2; }
.vp-mochi__ear--right{ right:5px; transform:rotate(18deg); }
.vp-mochi__tail{
  position:absolute;
  right:-6px;
  bottom:8px;
  width:16px;
  height:16px;
  border-radius:50% 50% 50% 50% / 60% 60% 40% 40%;
  background:radial-gradient(ellipse at 28% 26%,#fff 0 20%,#e4dbf0 34%,#c2b2dd 68%,#a692cc 100%);
  border:1px solid rgba(255,255,255,.75);
  box-shadow:0 3px 7px rgba(0,0,0,.14), inset 0 1px 0 rgba(255,255,255,.4);
  transform-origin:left center;
  animation:vp-mochi-tail 2.6s cubic-bezier(.4,.1,.4,1) infinite;
  pointer-events:none;
}
.vp-mochi__tail::after{
  content:"";
  position:absolute;
  inset:4px 5px 5px 4px;
  border-radius:50%;
  background:rgba(255,255,255,.6);
  filter:blur(.6px);
}
.vp-mochi__face{ position:absolute; inset:0; pointer-events:none; }
.vp-mochi__eye{
  position:absolute;
  top:23px;
  width:9px;
  height:11px;
  border-radius:50%;
  background:var(--vp-mochi-ink);
  box-shadow:0 1px 0 rgba(255,255,255,.55), inset 0 0 0 1px rgba(217,182,255,.28);
  transform-origin:center 55%;
  overflow:hidden;
}
.vp-mochi__eye::before{
  content:"";
  position:absolute;
  inset:0;
  border-radius:50%;
  background:
    radial-gradient(ellipse at 26% 16%, rgba(255,255,255,.98) 0 20%, transparent 38%),
    radial-gradient(ellipse at 72% 80%, rgba(255,255,255,.22) 0 24%, transparent 42%);
  pointer-events:none;
}
.vp-mochi__eye::after{
  content:"";
  position:absolute;
  top:2px;
  left:2px;
  width:3px;
  height:3px;
  border-radius:50%;
  background:#fff;
  box-shadow:0 0 3px rgba(255,255,255,.95), 3px 5px 0 -1.4px rgba(255,255,255,.5);
}
.vp-mochi__eye--left{ left:17px; }
.vp-mochi__eye--right{ right:17px; }
.vp-mochi__cheek{
  position:absolute;
  top:35px;
  width:12px;
  height:7px;
  border-radius:50%;
  background:radial-gradient(ellipse at center, var(--vp-mochi-cheek) 0 45%, transparent 78%);
  filter:blur(.4px);
  opacity:.82;
  pointer-events:none;
}
.vp-mochi__cheek--left{ left:6px; }
.vp-mochi__cheek--right{ right:6px; }
.vp-mochi__nose{
  position:absolute;
  top:31px;
  left:50%;
  width:4px;
  height:3px;
  transform:translateX(-50%);
  border-radius:50% 50% 50% 50% / 60% 60% 40% 40%;
  background:var(--vp-mochi-ink);
  box-shadow:inset 0 -.5px 0 rgba(0,0,0,.25), .5px -.5px 0 rgba(255,255,255,.4);
  opacity:.94;
  pointer-events:none;
}
.vp-mochi__mouth{
  position:absolute;
  top:35px;
  left:50%;
  width:10px;
  height:6px;
  transform:translateX(-50%);
  pointer-events:none;
}
.vp-mochi__mouth::before, .vp-mochi__mouth::after{
  content:"";
  position:absolute;
  top:3px;
  width:8px;
  height:1.7px;
  border:0;
  border-radius:2px;
  background:var(--vp-mochi-ink);
}
.vp-mochi__mouth::before{ left:-1px; transform:rotate(-45deg); }
.vp-mochi__mouth::after{ right:-1px; transform:rotate(45deg); }
.vp-mochi[data-profile="macho"] .vp-mochi__mouth{
  width:12px;
  height:7px;
  background:var(--vp-mochi-ink);
  clip-path:polygon(0 100%,50% 0,100% 100%,80% 100%,50% 17%,20% 100%);
}
.vp-mochi[data-profile="macho"] .vp-mochi__mouth::before,
.vp-mochi[data-profile="macho"] .vp-mochi__mouth::after{ display:none; }
.vp-mochi[data-state="hablando"] .vp-mochi__mouth::before,
.vp-mochi[data-state="hablando"] .vp-mochi__mouth::after{ height:1.7px; top:3px; }
.vp-mochi[data-profile="macho"][data-state="enamorado"] .vp-mochi__mouth{ background:#e84a8a; }

.vp-mochi__particles{ position:absolute; inset:0; pointer-events:none; overflow:visible; }
.vp-mochi__particle{
  position:absolute;
  left:50%;
  top:8px;
  font-size:14px;
  line-height:1;
  pointer-events:none;
  animation:vp-mochi-particle 950ms cubic-bezier(.2,.8,.25,1) forwards;
  filter:drop-shadow(0 2px 5px rgba(0,0,0,.22));
}
.vp-mochi__bubble{
  position:absolute;
  z-index:3;
  bottom:calc(100% + 16px);
  width:max-content;
  min-width:min(220px,72vw);
  max-width:min(72vw,380px);
  box-sizing:border-box;
  padding:12px 30px 12px 14px;
  border:1px solid rgba(255,255,255,.22);
  border-radius:18px 18px 18px 6px;
  background:var(--vp-mochi-bubble-bg);
  box-shadow:0 14px 34px rgba(0,0,0,.32), 0 0 0 1px rgba(255,209,120,.08), inset 0 1px 0 rgba(255,255,255,.1);
  backdrop-filter:blur(16px) saturate(1.3);
  color:var(--vp-mochi-bubble-fg);
  font-size:13.5px;
  line-height:1.45;
  letter-spacing:.1px;
  opacity:0;
  transform:translateY(10px) scale(.94);
  transform-origin:bottom left;
  transition:opacity .26s ease, transform .36s cubic-bezier(.34,1.56,.64,1);
  pointer-events:auto;
  overflow-wrap:anywhere;
}
.vp-mochi__bubble::before{
  content:"";
  position:absolute;
  inset:1px 1px auto 1px;
  height:40%;
  border-radius:17px 17px 40px 40px / 17px 17px 26px 26px;
  background:linear-gradient(180deg, rgba(255,255,255,.14), rgba(255,255,255,0));
  pointer-events:none;
}
.vp-mochi__bubble::after{
  content:"";
  position:absolute;
  left:14px;
  bottom:-7px;
  width:14px;
  height:14px;
  background:var(--vp-mochi-bubble-bg);
  border-left:1px solid rgba(255,255,255,.22);
  border-bottom:1px solid rgba(255,255,255,.22);
  transform:rotate(-45deg);
  border-radius:0 0 0 3px;
  backdrop-filter:blur(16px);
}
.vp-mochi--bottom-right .vp-mochi__bubble,
.vp-mochi--top-right .vp-mochi__bubble{
  inset-inline-end:0;
  left:auto;
  transform-origin:bottom right;
  border-radius:18px 18px 6px 18px;
}
.vp-mochi--bottom-right .vp-mochi__bubble::after,
.vp-mochi--top-right .vp-mochi__bubble::after{
  left:auto;
  right:18px;
}
.vp-mochi--bottom-left .vp-mochi__bubble,
.vp-mochi--top-left .vp-mochi__bubble{
  inset-inline-start:0;
}
.vp-mochi__bubble.is-open{
  opacity:1;
  transform:translateY(0) scale(1);
}
.vp-mochi__texto{ white-space:pre-wrap; }
.vp-mochi__cerrar{
  position:absolute;
  top:6px;
  inset-inline-end:7px;
  display:grid;
  place-items:center;
  width:20px;
  height:20px;
  border:0;
  border-radius:50%;
  background:rgba(255,255,255,.14);
  color:inherit;
  cursor:pointer;
  font:inherit;
  font-size:15px;
  line-height:1;
  opacity:.75;
  transition:background .2s ease, opacity .2s ease, transform .2s cubic-bezier(.34,1.56,.64,1);
}
.vp-mochi__cerrar:hover, .vp-mochi__cerrar:focus-visible{
  background:rgba(255,255,255,.28);
  opacity:1;
  outline:none;
  transform:scale(1.15) rotate(90deg);
}
.vp-mochi__name{
  position:absolute;
  bottom:-18px;
  left:50%;
  transform:translateX(-50%);
  font-size:10px;
  letter-spacing:.6px;
  text-transform:uppercase;
  color:rgba(58,37,64,.75);
  background:linear-gradient(180deg, rgba(255,255,255,.86), rgba(255,255,255,.68));
  backdrop-filter:blur(6px);
  padding:2px 7px;
  border-radius:999px;
  border:1px solid rgba(255,255,255,.92);
  box-shadow:0 3px 10px rgba(0,0,0,.1), inset 0 1px 0 rgba(255,255,255,.9);
  pointer-events:none;
  white-space:nowrap;
  opacity:0;
  transition:opacity .25s ease, transform .25s cubic-bezier(.34,1.56,.64,1);
}
.vp-mochi:hover .vp-mochi__name{
  opacity:1;
  transform:translateX(-50%) translateY(-2px);
}
.vp-mochi.is-visible{
  animation:vp-mochi-entrada .65s cubic-bezier(.34,1.56,.64,1) both;
}
.vp-mochi[data-state="idle"] .vp-mochi__body{
  animation:vp-mochi-respirar 4.2s cubic-bezier(.45,.05,.35,.95) infinite;
}
.vp-mochi[data-state="idle"] .vp-mochi__eye{
  animation:vp-mochi-parpadeo 7.4s cubic-bezier(.5,0,.5,1) infinite;
}
.vp-mochi[data-state="idle"] .vp-mochi__eye--right{
  animation-delay:.06s;
}
.vp-mochi__body:hover{
  filter:saturate(1.12) brightness(1.06);
}
.vp-mochi__body:hover .vp-mochi__ear--left{
  animation:vp-mochi-oreja .55s cubic-bezier(.34,1.56,.64,1);
}
.vp-mochi[data-state="pensando"] .vp-mochi__body{
  animation:vp-mochi-pensar-cuerpo 2.2s cubic-bezier(.45,.05,.35,.95) infinite;
}
.vp-mochi[data-state="pensando"] .vp-mochi__eye{
  animation:vp-mochi-mirada 2.2s cubic-bezier(.7,0,.3,1) infinite;
}
.vp-mochi[data-state="pensando"] .vp-mochi__tail{
  animation-duration:1.4s;
}
.vp-mochi[data-state="hablando"] .vp-mochi__mouth{
  animation:vp-mochi-hablar .27s cubic-bezier(.4,.05,.4,1) infinite;
}
.vp-mochi[data-state="hablando"] .vp-mochi__body{
  animation:vp-mochi-hablar-cuerpo .54s cubic-bezier(.35,.05,.35,1) infinite;
}
.vp-mochi[data-state="hablando"] .vp-mochi__cheek{
  animation:vp-mochi-rubor .54s cubic-bezier(.45,.05,.35,.95) infinite alternate;
}
.vp-mochi[data-state="hablando"] .vp-mochi__tail{
  animation:vp-mochi-tail-happy .54s cubic-bezier(.4,.1,.4,1) infinite;
}
.vp-mochi[data-state="durmiendo"] .vp-mochi__eye{
  height:2px;
  top:27px;
  border-radius:2px;
  animation:none;
  opacity:.9;
}
.vp-mochi[data-state="durmiendo"] .vp-mochi__mouth::before,
.vp-mochi[data-state="durmiendo"] .vp-mochi__mouth::after{
  opacity:.6;
}
.vp-mochi[data-state="durmiendo"] .vp-mochi__body{
  animation:vp-mochi-dormir 3.6s cubic-bezier(.45,.05,.35,.95) infinite;
}
.vp-mochi[data-state="durmiendo"] .vp-mochi__body::after{
  content:"z z z";
  position:absolute;
  top:-18px;
  right:-10px;
  font-size:10px;
  letter-spacing:2px;
  color:#dfc8ff;
  text-shadow:0 1px 6px rgba(0,0,0,.15), 0 0 8px rgba(217,182,255,.4);
  animation:vp-mochi-flotar 2.8s cubic-bezier(.45,.05,.35,.95) infinite;
}
.vp-mochi[data-state="durmiendo"] .vp-mochi__tail{
  animation:vp-mochi-tail-sleep 3.6s cubic-bezier(.45,.05,.35,.95) infinite;
}
.vp-mochi[data-state="despidiendo"] .vp-mochi__body{
  animation:vp-mochi-despedir .95s cubic-bezier(.45,.05,.35,.95) infinite;
}
.vp-mochi[data-state="despidiendo"] .vp-mochi__ear--right{
  animation:vp-mochi-oreja .48s cubic-bezier(.34,1.56,.64,1) infinite alternate;
}
.vp-mochi[data-state="curioso"] .vp-mochi__body{
  animation:vp-mochi-curioso 1s cubic-bezier(.34,1.56,.64,1) both;
}
.vp-mochi[data-state="enamorado"] .vp-mochi__body{
  animation:vp-mochi-enamorado 1.3s cubic-bezier(.5,-.2,.4,1.3) infinite;
}
.vp-mochi[data-state="enamorado"] .vp-mochi__cheek{
  opacity:1;
  transform:scale(1.25);
  filter:blur(.3px);
}
.vp-mochi[data-state="enamorado"] .vp-mochi__eye{
  transform:scale(1.08);
}
.vp-mochi[data-state="poke"] .vp-mochi__body{
  animation:vp-mochi-poke .52s cubic-bezier(.2,.8,.25,1) both;
}
.vp-mochi[data-state="saludando"] .vp-mochi__body{
  animation:vp-mochi-saludo .82s cubic-bezier(.34,1.56,.64,1) infinite;
}
.vp-mochi[data-state="estirando"] .vp-mochi__body{
  animation:vp-mochi-estirar 1.2s cubic-bezier(.45,.05,.35,.95) both;
}

/* Keyframes base enriquecidos */
@keyframes vp-mochi-entrada{
  0%{ opacity:0; transform:translateY(20px) scale(.4) rotate(-6deg); }
  55%{ opacity:1; transform:translateY(-8px) scale(1.12) rotate(3deg); }
  78%{ transform:translateY(3px) scale(.96) rotate(-1deg); }
  92%{ transform:translateY(-1px) scale(1.02) rotate(.5deg); }
  100%{ transform:translateY(0) scale(1) rotate(0); }
}
@keyframes vp-mochi-aura{
  0%,100%{ transform:scale(1); opacity:.6; }
  50%{ transform:scale(1.12); opacity:1; }
}
@keyframes vp-mochi-respirar{
  0%,100%{ transform:translateY(0) scale(1,1); }
  35%{ transform:translateY(-3.2px) scale(1.035,.965); }
  55%{ transform:translateY(-2.6px) scale(1.028,.972); }
  80%{ transform:translateY(-.8px) scale(.988,1.016); }
}
@keyframes vp-mochi-parpadeo{
  0%,7%,100%{ transform:scaleY(1); }
  8.4%{ transform:scaleY(.06); }
  9.6%{ transform:scaleY(.55); }
  10.8%{ transform:scaleY(1); }
  38%,40.5%{ transform:scaleY(1); }
  39.2%{ transform:scaleY(.06); }
  40%{ transform:scaleY(.5); }
  72%,76%{ transform:scaleY(1); }
  73%{ transform:scaleY(.06); }
  73.8%{ transform:scaleY(.35); }
  74.4%{ transform:scaleY(.06); }
  75.2%{ transform:scaleY(1); }
}
@keyframes vp-mochi-pensar-cuerpo{
  0%,100%{ transform:rotate(0) translateY(0); }
  28%{ transform:rotate(5.5deg) translateY(-2.8px) scale(1.02,.98); }
  62%{ transform:rotate(-4.5deg) translateY(-.5px) scale(.99,1.01); }
}
@keyframes vp-mochi-mirada{
  0%,100%{ transform:translate(0,0); }
  25%{ transform:translate(2.2px,-1.2px); }
  60%{ transform:translate(-1.8px,.8px); }
}
@keyframes vp-mochi-hablar{
  0%,100%{ transform:translateX(-50%) scale(1,.75); }
  22%{ transform:translateX(-50%) scale(1.05,1.15); }
  45%{ transform:translateX(-50%) scale(1.16,1.55); }
  70%{ transform:translateX(-50%) scale(.96,.9); }
}
@keyframes vp-mochi-hablar-cuerpo{
  0%,100%{ transform:translateY(0) rotate(0) scale(1,1); }
  28%{ transform:translateY(-2.4px) rotate(-1.5deg) scale(1.03,.97); }
  68%{ transform:translateY(-1.2px) rotate(1.2deg) scale(.98,1.02); }
}
@keyframes vp-mochi-rubor{
  from{ opacity:.6; transform:scale(1); }
  to{ opacity:1; transform:scale(1.2); }
}
@keyframes vp-mochi-oreja{
  0%,100%{ transform:rotate(-18deg); }
  35%{ transform:rotate(-38deg) translateY(-3.5px); }
  65%{ transform:rotate(-22deg) translateY(-1px); }
  85%{ transform:rotate(-16deg) translateY(-.2px); }
}
@keyframes vp-mochi-tail{
  0%,100%{ transform:rotate(-8deg) scale(1,1); }
  26%{ transform:rotate(11deg) scale(1.03,.97); }
  38%{ transform:rotate(19deg) scale(1.06,.95); }
  44%{ transform:rotate(16deg) scale(1.04,.97); }
  68%{ transform:rotate(-2deg) scale(.99,1.01); }
}
@keyframes vp-mochi-tail-happy{
  0%,100%{ transform:rotate(-14deg); }
  50%{ transform:rotate(28deg) scale(1.08,.94); }
}
@keyframes vp-mochi-tail-sleep{
  0%,100%{ transform:rotate(-9deg) scale(.97,1); }
  50%{ transform:rotate(-2deg) scale(1.01,1); }
}
@keyframes vp-mochi-flotar{
  0%,100%{ opacity:.25; transform:translateY(0) scale(.82) rotate(-8deg); }
  50%{ opacity:1; transform:translateY(-11px) scale(1.08) rotate(8deg); }
}
@keyframes vp-mochi-dormir{
  0%,100%{ transform:translateY(0) scale(1.02,.98); }
  50%{ transform:translateY(2px) scale(1.06,.92); }
}
@keyframes vp-mochi-despedir{
  0%,100%{ transform:rotate(0) translateY(0) scale(1); }
  24%{ transform:rotate(-13deg) translateY(-3px) scale(1.03,.97); }
  50%{ transform:rotate(0) translateY(0) scale(1); }
  76%{ transform:rotate(13deg) translateY(-3px) scale(1.03,.97); }
}
@keyframes vp-mochi-curioso{
  0%{ transform:rotate(0) translateY(0) scale(1); }
  28%{ transform:rotate(-10deg) translateY(-3.5px) scale(1.04,.96); }
  65%{ transform:rotate(8deg) translateY(-1.5px) scale(1.02,.98); }
  85%{ transform:rotate(-2deg) translateY(0) scale(1); }
  100%{ transform:rotate(0) translateY(0) scale(1); }
}
@keyframes vp-mochi-enamorado{
  0%,100%{ transform:translateY(0) scale(1); }
  20%{ transform:translateY(-4.5px) rotate(-2deg) scale(1.08,.92); }
  35%{ transform:translateY(-1px) rotate(0) scale(1,1); }
  54%{ transform:translateY(-10px) rotate(2.5deg) scale(1.12,.88); }
  74%{ transform:translateY(1px) rotate(0) scale(.98,1.03); }
}
@keyframes vp-mochi-poke{
  0%{ transform:translateY(0) scale(1,1); }
  18%{ transform:translateY(8px) rotate(-3deg) scale(.78,1.24); }
  45%{ transform:translateY(-11px) rotate(5deg) scale(1.15,.85); }
  68%{ transform:translateY(3px) rotate(-2deg) scale(.95,1.08); }
  86%{ transform:translateY(-1.5px) rotate(.8deg) scale(1.02,.99); }
  100%{ transform:translateY(0) rotate(0) scale(1,1); }
}
@keyframes vp-mochi-saludo{
  0%,100%{ transform:translateY(0) rotate(0) scale(1,1); }
  18%{ transform:translateY(2px) rotate(-4deg) scale(1.05,.94); }
  40%{ transform:translateY(-9px) rotate(16deg) scale(.93,1.11); }
  65%{ transform:translateY(-6px) rotate(-14deg) scale(.95,1.08); }
  84%{ transform:translateY(1px) rotate(4deg) scale(1.02,.98); }
}
@keyframes vp-mochi-estirar{
  0%{ transform:scale(1,1); }
  22%{ transform:scale(1.16,.8) translateY(3px); }
  52%{ transform:scale(.88,1.22) translateY(-11px) rotate(-3deg); }
  78%{ transform:scale(1.04,.96) translateY(1px) rotate(1deg); }
  100%{ transform:scale(1,1); }
}
@keyframes vp-mochi-particle{
  0%{ opacity:0; transform:translate(-50%, 8px) scale(.5) rotate(0deg); }
  20%{ opacity:1; }
  100%{ opacity:0; transform:translate(-50%, -48px) scale(1.25) rotate(18deg); }
}
@media (prefers-reduced-motion: reduce){
  .vp-mochi, .vp-mochi *{ animation:none !important; transition:opacity .15s ease !important; }
  .vp-mochi.is-visible .vp-mochi__body{ opacity:1; transform:none; }
  .vp-mochi__aura{ display:none; }
}
@media (max-width:480px){
  .vp-mochi__wrap{ width:56px; height:52px; }
  .vp-mochi__body{ width:56px; height:52px; }
  .vp-mochi__eye{ top:19px; }
  .vp-mochi__cheek{ top:30px; }
  .vp-mochi__mouth{ top:31px; }
  .vp-mochi__tail{ width:14px; height:14px; }
  .vp-mochi__bubble{ font-size:12.5px; min-width:min(180px,82vw); max-width:min(82vw,300px); }
}
`;
    VP._mochiMacho.ESTILOS_BASE = ESTILOS_BASE;
})(window);

(function (window) {
    'use strict';

    var VP = window.VP;

    var ESTILOS_MACHO = `
.vp-mochi[data-profile=\"macho\"]{
  --vp-mochi-ink:#263c59;
  --vp-mochi-cheek:#8bb7e6;
  --vp-mochi-bubble-bg:rgba(20,31,49,.95);
  --vp-mochi-accent:#9fd8f5;
  --vp-mochi-pink:#b9d9f5;
  --vp-mochi-lav:#a9c5e8;
}
.vp-mochi[data-profile=\"macho\"] .vp-mochi__aura{
  background:radial-gradient(ellipse at center,rgba(135,190,245,.25) 0 45%,transparent 72%);
}
.vp-mochi[data-profile=\"macho\"] .vp-mochi__body{
  background:radial-gradient(ellipse at 28% 18%,rgba(255,255,255,.98) 0 6%,transparent 28%),linear-gradient(145deg,#f5faff 0%,#dce9f7 44%,#b8cde8 100%);
  box-shadow:inset 0 -6px 12px rgba(48,79,119,.14),inset 0 2px 0 rgba(255,255,255,.78),0 8px 20px rgba(18,35,58,.28);
}
.vp-mochi[data-profile=\"macho\"] .vp-mochi__ear{
  background:linear-gradient(145deg,#f2f8ff,#c0d4ed);
}
.vp-mochi[data-profile=\"macho\"] .vp-mochi__ear::after{
  background:linear-gradient(180deg,#b6d9f4,#7fa9d4);
  opacity:1;
}
.vp-mochi[data-profile=\"macho\"] .vp-mochi__tail{
  background:radial-gradient(ellipse at 30% 30%,#fff 0 18%,#d2e2f3 28%,#a9c3e2 100%);
}
.vp-mochi[data-profile=\"macho\"]:is([data-state="celebrando"],[data-state="celebrandoResumen"]) .vp-mochi__body{
  animation:vp-mochi-macho-celebrar 1.35s cubic-bezier(.34,1.56,.64,1) infinite;
}
.vp-mochi[data-profile=\"macho\"]:is([data-state="celebrando"],[data-state="celebrandoResumen"]) .vp-mochi__particles::before{
  content:"✦  ✧  ✦";
  position:absolute;
  left:50%;
  top:-5px;
  color:#a9dcff;
  font-size:16px;
  letter-spacing:5px;
  white-space:nowrap;
  text-shadow:0 0 8px rgba(134,205,255,.95);
  animation:vp-mochi-macho-celebrar-brillos 1.35s cubic-bezier(.2,.8,.25,1) infinite;
}
@keyframes vp-mochi-macho-celebrar{
  0%{transform:translateY(0) scale(1,1);}
  20%{transform:translateY(4px) scale(1.1,.88);}
  50%{transform:translateY(-12px) scale(.92,1.14) rotate(-3deg);}
  74%{transform:translateY(2px) scale(1.05,.96) rotate(1deg);}
  88%{transform:translateY(-1px) scale(.99,1.01);}
  100%{transform:translateY(0) scale(1,1);}
}
@keyframes vp-mochi-macho-celebrar-brillos{
  0%{opacity:0;transform:translate(-50%,8px) scale(.5);}
  28%{opacity:1;transform:translate(-50%,-10px) scale(1.2);}
  100%{opacity:0;transform:translate(-50%,-26px) scale(1.35);}
}
.vp-mochi[data-profile=\"macho\"] .vp-mochi__wrap{
  width:96px;
  height:92px;
  transform:scale(.9);
  transform-origin:top center;
  filter:drop-shadow(0 10px 20px rgba(30,14,48,.35));
  transition:transform .35s cubic-bezier(.22,1,.36,1), filter .35s ease;
}
.vp-mochi[data-profile=\"macho\"] .vp-mochi__wrap:hover{
  transform:scale(.94) translateY(-2px);
  filter:drop-shadow(0 13px 23px rgba(30,14,48,.3));
}
.vp-mochi[data-profile=\"macho\"] :is(.vp-mochi__body,.vp-mochi__tail,.vp-mochi__ear,.vp-mochi__cheek,.vp-mochi__mouth,.vp-mochi__bowtie,.vp-mochi__eye,.vp-mochi__pupil,.vp-mochi__nose){
  transition:transform .24s cubic-bezier(.22,1,.36,1), translate .24s cubic-bezier(.22,1,.36,1), rotate .24s cubic-bezier(.22,1,.36,1), scale .24s cubic-bezier(.22,1,.36,1), opacity .2s ease, filter .28s ease;
}
.vp-mochi[data-profile=\"macho\"] .vp-mochi__body{
  width:96px;
  height:88px;
  will-change:transform;
  border-radius:46% 46% 42% 42% / 54% 54% 40% 40%;
  background:radial-gradient(60% 45% at 30% 16%,rgba(255,255,255,.98) 0%,rgba(255,255,255,0) 60%),radial-gradient(80% 70% at 70% 90%,rgba(0,0,0,.06) 0%,rgba(0,0,0,0) 70%),linear-gradient(150deg,#f3f9ff 0%,#dce9f8 45%,#b4cbe8 100%);
  box-shadow:inset 0 -10px 16px rgba(48,79,119,.16),inset 0 3px 0 rgba(255,255,255,.82),0 10px 22px rgba(18,35,58,.25);
}
.vp-mochi[data-profile=\"macho\"] .vp-mochi__ear{
  top:-13px;
  width:27px;
  height:33px;
  will-change:transform;
  background:linear-gradient(150deg,#f2f8ff,#b8cee9);
  box-shadow:inset 0 -4px 8px rgba(48,79,119,.15);
}
.vp-mochi[data-profile=\"macho\"] .vp-mochi__ear::after{
  inset:7px 6px 6px;
  background:linear-gradient(180deg,#b6d9f4,#7fa9d4);
  opacity:1;
}
.vp-mochi[data-profile=\"macho\"] .vp-mochi__tail{
  right:-11px;
  bottom:7px;
  width:38px;
  height:22px;
  will-change:transform;
  background:radial-gradient(ellipse at 30% 30%,#fff 0 20%,#d2e2f3 32%,#a9c3e2 100%);
}
.vp-mochi[data-profile=\"macho\"] .vp-mochi__eye{
  top:33px;
  width:12px;
  height:15px;
  border-radius:50% 50% 46% 46%;
}
.vp-mochi[data-profile=\"macho\"] .vp-mochi__eye--left{ left:24px; right:auto; }
.vp-mochi[data-profile=\"macho\"] .vp-mochi__eye--right{ right:24px; left:auto; }
.vp-mochi[data-profile=\"macho\"] .vp-mochi__nose{ top:45px; width:6px; height:4px; }
.vp-mochi[data-profile=\"macho\"] .vp-mochi__mouth{ top:50px; width:12px; height:7px; border-bottom-width:2px; }
.vp-mochi[data-profile=\"macho\"] .vp-mochi__bowtie{
  position:absolute;
  top:66px;
  left:50%;
  width:26px;
  height:12px;
  transform:translateX(-50%);
  z-index:2;
  pointer-events:none;
}
.vp-mochi[data-profile=\"macho\"] .vp-mochi__bowtie::before,
.vp-mochi[data-profile=\"macho\"] .vp-mochi__bowtie::after{
  content:"";
  position:absolute;
  top:0;
  width:11px;
  height:12px;
  background:linear-gradient(150deg,#8fb8ff,#3f74e0);
  border:1px solid rgba(255,255,255,.7);
  clip-path:polygon(0 0,100% 20%,100% 80%,0 100%);
}
.vp-mochi[data-profile=\"macho\"] .vp-mochi__bowtie::after{
  right:0;
  clip-path:polygon(100% 0,0 20%,0 80%,100% 100%);
}
.vp-mochi[data-profile=\"macho\"] .vp-mochi__bowtie-knot{
  position:absolute;
  top:2px;
  left:50%;
  width:6px;
  height:8px;
  transform:translateX(-50%);
  border-radius:2px;
  background:#2a5bc4;
  border:1px solid rgba(255,255,255,.7);
  z-index:1;
}
`;
    VP._mochiMacho.ESTILOS_MACHO = ESTILOS_MACHO;
})(window);

(function (window) {
    'use strict';

    var VP = window.VP;

    // ═══════════════════════════════════════════════════════════════════
    //  SISTEMA DE ANIMACIONES VIVAS Y DINÁMICAS (MACHO)
    // ═══════════════════════════════════════════════════════════════════

    var ANIMACIONES_MACHO = [
        // ─── 1. ORIGEN / VARIABLES / SHINE DINÁMICO ───
        '.vp-mochi[data-profile=\"macho\"] .vp-mochi__body{transform-origin:50% 92%;}',
        '.vp-mochi[data-profile=\"macho\"] .vp-mochi__ear{--oreja:1;transform-origin:center bottom;}',
        '.vp-mochi[data-profile=\"macho\"] .vp-mochi__ear ~ .vp-mochi__ear{--oreja:-1;}',
        '.vp-mochi[data-profile=\"macho\"] .vp-mochi__tail{transform-origin:left center;}',
        '.vp-mochi[data-profile=\"macho\"] .vp-mochi__shine{animation:vp-mochi-macho-shine 5.2s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-shine{0%,100%{opacity:.82;transform:rotate(-30deg) scale(1,1);}35%{opacity:1;transform:rotate(-28deg) scale(1.15,1.08) translate(.5px,-.5px);}70%{opacity:.68;transform:rotate(-32deg) scale(.92,.95);}}',

        // ─── 2. BODY ───
        // idle: 5.2s respiración biológica + impulso con anticipación y settle elástico
        '.vp-mochi[data-profile=\"macho\"][data-state="idle"] .vp-mochi__body{animation:vp-mochi-macho-rebotar 5.2s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-rebotar{0%,100%{transform:translateY(0) rotate(0deg) scale(1,1);}8%{transform:translateY(.3px) rotate(.25deg) scale(1.005,.998);}18%{transform:translateY(-1.5px) rotate(-1deg) scale(1.02,.982);}28%{transform:translateY(-2.8px) rotate(-1.5deg) scale(1.03,.972);}38%{transform:translateY(-1px) rotate(.5deg) scale(1.005,1.005);}48%{transform:translateY(.2px) rotate(0deg) scale(1,1.004);}56%{transform:translateY(.8px) rotate(-.35deg) scale(1.012,.992);}66%{transform:translateY(-.7px) rotate(-1deg) scale(1.025,.965);}74%{transform:translateY(-6.5px) rotate(-2deg) scale(.94,1.08);}80%{transform:translateY(-3.5px) rotate(-.7deg) scale(.98,1.035);}86%{transform:translateY(1px) rotate(.9deg) scale(1.035,.95);}92%{transform:translateY(-.5px) rotate(.2deg) scale(.995,1.012);}96%{transform:translateY(.2px) rotate(0deg) scale(1.001,.998);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="pensando"] .vp-mochi__body{animation:vp-mochi-macho-pensar 2.2s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-pensar{0%,100%{transform:translateY(0) rotate(0) scale(1,1);}20%{transform:translateY(-.8px) rotate(-2.5deg) scale(1.01,.99);}40%{transform:translateY(-3.2px) rotate(-10.5deg) scale(1.04,.97);}65%{transform:translateY(-1.8px) rotate(-7.5deg) scale(1.02,.985);}85%{transform:translateY(1.2px) rotate(7.5deg) scale(.98,1.025);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="leyendo"] .vp-mochi__body{animation:vp-mochi-macho-leer 1.7s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-leer{0%,100%{transform:rotate(0deg) translateY(0) scale(1);}28%{transform:rotate(-3.5deg) translateY(-1.5px) scale(1.01,.99);}58%{transform:rotate(2.5deg) translateY(0) scale(.99,1.01);}80%{transform:rotate(-1.2deg) translateY(-.6px) scale(1);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="saludando"] .vp-mochi__body{animation:vp-mochi-macho-saludo .82s cubic-bezier(.34,1.56,.64,1) infinite;}',
        '@keyframes vp-mochi-macho-saludo{0%,100%{transform:translateY(0) rotate(0) scale(1,1);}12%{transform:translateY(1.8px) rotate(-3deg) scale(1.035,.95);}32%{transform:translateY(-7px) rotate(11deg) scale(.95,1.07);}48%{transform:translateY(-.7px) rotate(-1.5deg) scale(1.02,.98);}68%{transform:translateY(-6px) rotate(-10deg) scale(.96,1.06);}84%{transform:translateY(.7px) rotate(4deg) scale(1.02,.99);}94%{transform:translateY(-1px) rotate(-1deg) scale(1,1);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="somnoliento"] .vp-mochi__body{animation:vp-mochi-macho-somnoliento 3.4s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-somnoliento{0%,100%{transform:translateY(0) rotate(0) scale(1,1);}45%{transform:translateY(2px) rotate(-2deg) scale(1.02,.98);}72%{transform:translateY(.5px) rotate(1.2deg) scale(1.005,.995);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="durmiendo"] .vp-mochi__body{animation:vp-mochi-macho-dormir 3.6s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-dormir{0%,100%{transform:translateY(1.2px) rotate(1.2deg) scale(1.035,.955);}48%{transform:translateY(4.2px) rotate(-1.2deg) scale(1.085,.895);}72%{transform:translateY(2.2px) rotate(0deg) scale(1.055,.915);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="despidiendo"] .vp-mochi__body{animation:vp-mochi-macho-despedir .95s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-despedir{0%,100%{transform:translateY(0) rotate(0deg) scale(1,1);}24%{transform:translateY(-4.5px) rotate(15deg) scale(1.04,.96);}50%{transform:translateY(0) rotate(0deg) scale(1,1);}76%{transform:translateY(-4.5px) rotate(-15deg) scale(1.04,.96);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="curioso"] .vp-mochi__body{animation:vp-mochi-macho-curioso 1.4s cubic-bezier(.34,1.56,.64,1) infinite alternate;}',
        '@keyframes vp-mochi-macho-curioso{0%{transform:translateY(0) rotate(0deg) scale(1,1);}16%{transform:translateY(2.5px) rotate(-2.5deg) scale(1.06,.91);}38%{transform:translateY(-7px) rotate(12.5deg) scale(.95,1.08);}58%{transform:translateY(-4.5px) rotate(8deg) scale(1.02,.98);}74%{transform:translateY(-1.2px) rotate(2deg) scale(1.01,.995);}100%{transform:translateY(-2px) rotate(-2deg) scale(1.02,.985);}}',

        // enamorado: 1.3s con doble latido de corazón
        '.vp-mochi[data-profile=\"macho\"][data-state="enamorado"] .vp-mochi__body{animation:vp-mochi-macho-contento 1.3s cubic-bezier(.5,-.2,.4,1.3) infinite;}',
        '@keyframes vp-mochi-macho-contento{0%,100%{transform:translateY(0) rotate(0deg) scale(1,1);}10%{transform:translateY(1px) rotate(-1deg) scale(1.03,.965);}20%{transform:translateY(-4px) rotate(-2.5deg) scale(1.075,.925);}30%{transform:translateY(-1px) rotate(0deg) scale(1,1);}42%{transform:translateY(2px) rotate(1deg) scale(1.04,.955);}54%{transform:translateY(-9px) rotate(2.5deg) scale(1.1,.9);}62%{transform:translateY(-6px) rotate(1deg) scale(1.05,.95);}74%{transform:translateY(1px) rotate(0deg) scale(.98,1.02);}88%{transform:translateY(-2px) rotate(-.5deg) scale(1.02,.985);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="poke"] .vp-mochi__body{animation:vp-mochi-macho-poke .52s cubic-bezier(.2,.8,.25,1) both;}',
        '@keyframes vp-mochi-macho-poke{0%{transform:translateY(0) rotate(0) scale(1,1);}12%{transform:translateY(-1px) rotate(0) scale(1.04,.96);}28%{transform:translateY(7px) rotate(-3deg) scale(.8,1.22);}52%{transform:translateY(-10.5px) rotate(5deg) scale(1.14,.84);}72%{transform:translateY(2.5px) rotate(-2.2deg) scale(.95,1.08);}88%{transform:translateY(-1.2px) rotate(.6deg) scale(1.02,.985);}100%{transform:translateY(0) rotate(0) scale(1,1);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="estirando"] .vp-mochi__body{animation:vp-mochi-macho-estirar 1.2s cubic-bezier(.45,.05,.35,.95) both;}',
        '@keyframes vp-mochi-macho-estirar{0%{transform:translateY(0) rotate(0) scale(1,1);}12%{transform:translateY(2.5px) rotate(0) scale(1.08,.9);}30%{transform:translateY(-10.5px) rotate(-5deg) scale(.86,1.22);}48%{transform:translateY(-9px) rotate(4deg) scale(.88,1.18);}64%{transform:translateY(-6.5px) rotate(-2.2deg) scale(.94,1.1);}82%{transform:translateY(2px) rotate(0deg) scale(1.06,.93);}100%{transform:translateY(0) rotate(0) scale(1,1);}}',

        // ─── 3. TAIL (COLA) ───
        // idle base: 2.6s látigo asimétrico orgánico con peso
        '.vp-mochi[data-profile=\"macho\"] .vp-mochi__tail{animation:vp-mochi-macho-cola 2.6s cubic-bezier(.4,.1,.4,1) infinite;}',
        '@keyframes vp-mochi-macho-cola{0%,100%{transform:rotate(-8deg) scale(1,1);}12%{transform:rotate(-4deg) scale(1.01,.99);}26%{transform:rotate(11deg) scale(1.03,.97);}38%{transform:rotate(19deg) scale(1.06,.95);}44%{transform:rotate(16deg) scale(1.04,.97);}56%{transform:rotate(4deg) scale(1.01,.99);}68%{transform:rotate(-2deg) scale(.99,1.01);}78%{transform:rotate(-6deg) scale(.99,1.005);}88%{transform:rotate(-9deg) scale(1,1);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="pensando"] .vp-mochi__tail{animation:vp-mochi-macho-cola-pensar 2.2s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-cola-pensar{0%,100%{transform:rotate(6deg) scale(1,1);}45%{transform:rotate(29deg) scale(1.06,.96);}75%{transform:rotate(17deg) scale(1.02,.99);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="leyendo"] .vp-mochi__tail{animation:vp-mochi-macho-cola-leer 1.7s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-cola-leer{0%,100%{transform:rotate(6deg) scale(1,1);}38%{transform:rotate(23deg) scale(1.045,.975);}70%{transform:rotate(14.5deg) scale(1.02,.99);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="saludando"] .vp-mochi__tail{animation:vp-mochi-macho-cola-saludo .41s cubic-bezier(.34,1.56,.64,1) infinite;}',
        '@keyframes vp-mochi-macho-cola-saludo{0%,100%{transform:rotate(-22deg) scale(1,1);}40%{transform:rotate(36deg) scale(1.15,.91);}70%{transform:rotate(-8deg) scale(1.03,.98);}88%{transform:rotate(20deg) scale(1.06,.95);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="somnoliento"] .vp-mochi__tail{animation:vp-mochi-macho-cola-somnoliento 3.4s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-cola-somnoliento{0%,100%{transform:rotate(-7deg) scale(.99,1);}50%{transform:rotate(7deg) scale(1.015,1);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="durmiendo"] .vp-mochi__tail{animation:vp-mochi-macho-cola-dormido 3.6s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-cola-dormido{0%,100%{transform:rotate(-10deg) scale(.95,1);}55%{transform:rotate(-3deg) scale(1.015,1);}80%{transform:rotate(-7deg) scale(.985,1);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="despidiendo"] .vp-mochi__tail{animation:vp-mochi-macho-cola-despedir .95s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-cola-despedir{0%,100%{transform:rotate(-9deg) scale(1,1);}28%{transform:rotate(26deg) scale(1.07,.95);}72%{transform:rotate(-24deg) scale(1.06,.96);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="curioso"] .vp-mochi__tail{animation:vp-mochi-macho-cola-curioso 1.4s cubic-bezier(.34,1.56,.64,1) infinite alternate;}',
        '@keyframes vp-mochi-macho-cola-curioso{0%{transform:rotate(-14deg) scale(1,1);}28%{transform:rotate(18deg) scale(1.08,.94);}46%{transform:rotate(32deg) scale(1.12,.93);}70%{transform:rotate(10deg) scale(1.04,.98);}100%{transform:rotate(3deg) scale(1,1);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="enamorado"] .vp-mochi__tail{animation:vp-mochi-macho-cola-amor .65s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-cola-amor{0%,100%{transform:rotate(-14deg) scale(1,1);}35%{transform:rotate(20deg) scale(1.07,.95);}70%{transform:rotate(3deg) scale(1.02,1);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="poke"] .vp-mochi__tail{animation:vp-mochi-macho-cola-poke .52s cubic-bezier(.2,.8,.25,1) both;}',
        '@keyframes vp-mochi-macho-cola-poke{0%{transform:rotate(-12deg) scale(1,1);}22%{transform:rotate(3deg) scale(1.03,.98);}44%{transform:rotate(38deg) scale(1.2,.86);}68%{transform:rotate(-12deg) scale(1.05,.96);}88%{transform:rotate(5deg) scale(1.02,.99);}100%{transform:rotate(-6deg) scale(1,1);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="estirando"] .vp-mochi__tail{animation:vp-mochi-macho-cola-estirar 1.2s cubic-bezier(.45,.05,.35,.95) both;}',
        '@keyframes vp-mochi-macho-cola-estirar{0%{transform:translateY(0) rotate(-8deg) scale(1,1);}12%{transform:translateY(2.5px) rotate(-4deg) scale(1.01,.99);}30%{transform:translateY(-10px) rotate(14deg) scale(1.12,.9);}48%{transform:translateY(-9px) rotate(14deg) scale(1.12,.9);}64%{transform:translateY(-6.5px) rotate(12deg) scale(1.1,.92);}82%{transform:translateY(2px) rotate(-4deg) scale(1.02,.98);}100%{transform:translateY(0) rotate(-8deg) scale(1,1);}}',

        // ─── 4. EARS (OREJAS) ───
        // idle base: 5.2s con 3 twitches espontáneos y desfase orgánico
        '.vp-mochi[data-profile=\"macho\"] .vp-mochi__ear{animation:vp-mochi-macho-oreja 5.2s cubic-bezier(.5,.1,.4,1) infinite;}',
        '@keyframes vp-mochi-macho-oreja{0%,9%,15%,22%,44%,52%,68%,100%{translate:0 0;rotate:calc(0deg * var(--oreja, 1));}11%{translate:0 -.8px;rotate:calc(-5deg * var(--oreja, 1));}12.5%{translate:0 -3.2px;rotate:calc(-19deg * var(--oreja, 1));}14%{translate:0 -1.5px;rotate:calc(-8deg * var(--oreja, 1));}18%{translate:0 -.4px;rotate:calc(3deg * var(--oreja, 1));}46%{translate:0 -1.8px;rotate:calc(9deg * var(--oreja, 1));}49%{translate:0 -2.6px;rotate:calc(15deg * var(--oreja, 1));}50.5%{translate:0 -1px;rotate:calc(-7deg * var(--oreja, 1));}70%{translate:0 -.5px;rotate:calc(-4deg * var(--oreja, 1));}72%{translate:0 -1.4px;rotate:calc(-11deg * var(--oreja, 1));}74%{translate:0 -.2px;rotate:calc(2deg * var(--oreja, 1));}}',
        '.vp-mochi[data-profile=\"macho\"] .vp-mochi__ear ~ .vp-mochi__ear{animation-delay:-2.8s;}',

        '.vp-mochi[data-profile=\"macho\"][data-state="pensando"] .vp-mochi__ear{animation:vp-mochi-macho-oreja-pensar 2.2s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-oreja-pensar{0%,100%{translate:0 0;rotate:calc(-3deg * var(--oreja, 1));}30%{translate:0 -1.2px;rotate:calc(6deg * var(--oreja, 1));}55%{translate:0 -2.8px;rotate:calc(17deg * var(--oreja, 1));}80%{translate:0 -1px;rotate:calc(-10deg * var(--oreja, 1));}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="leyendo"] .vp-mochi__ear{animation:vp-mochi-macho-oreja-leer 1.7s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-oreja-leer{0%,100%{translate:0 0;rotate:calc(-2deg * var(--oreja, 1));}26%{translate:0 -1px;rotate:calc(5deg * var(--oreja, 1));}50%{translate:0 -2px;rotate:calc(12deg * var(--oreja, 1));}76%{translate:0 -1px;rotate:calc(-7deg * var(--oreja, 1));}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="saludando"] .vp-mochi__ear{animation:vp-mochi-macho-oreja-onda .82s cubic-bezier(.34,1.56,.64,1) infinite;}',
        '.vp-mochi[data-profile=\"macho\"][data-state="despidiendo"] .vp-mochi__ear{animation:vp-mochi-macho-oreja-onda .95s cubic-bezier(.34,1.56,.64,1) infinite;}',
        '@keyframes vp-mochi-macho-oreja-onda{0%,100%{translate:0 0;rotate:calc(0deg * var(--oreja, 1));}28%{translate:0 -3.8px;rotate:calc(15deg * var(--oreja, 1));}55%{translate:0 -1.4px;rotate:calc(-11deg * var(--oreja, 1));}80%{translate:0 -2.2px;rotate:calc(6deg * var(--oreja, 1));}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="somnoliento"] .vp-mochi__ear{animation:vp-mochi-macho-oreja-somnoliento 3.4s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-oreja-somnoliento{0%,100%{translate:0 .6px;rotate:calc(5deg * var(--oreja, 1));}50%{translate:0 1.4px;rotate:calc(8deg * var(--oreja, 1));}72%{translate:0 .9px;rotate:calc(4deg * var(--oreja, 1));}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="durmiendo"] .vp-mochi__ear{animation:vp-mochi-macho-oreja-dormir 3.6s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-oreja-dormir{0%,100%{translate:0 1.2px;rotate:calc(9deg * var(--oreja, 1));}60%{translate:0 3.6px;rotate:calc(14.5deg * var(--oreja, 1));}85%{translate:0 2.2px;rotate:calc(11deg * var(--oreja, 1));}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="curioso"] .vp-mochi__ear{animation:vp-mochi-macho-oreja-curioso 1.4s cubic-bezier(.34,1.56,.64,1) infinite alternate;}',
        '@keyframes vp-mochi-macho-oreja-curioso{0%{translate:0 0;rotate:calc(0deg * var(--oreja, 1));}24%{translate:0 -4.5px;rotate:calc(-15deg * var(--oreja, 1));}52%{translate:0 -3.2px;rotate:calc(-9deg * var(--oreja, 1));}72%{translate:0 -1.8px;rotate:calc(-3deg * var(--oreja, 1));}100%{translate:0 -1px;rotate:calc(3deg * var(--oreja, 1));}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="enamorado"] .vp-mochi__ear{animation:vp-mochi-macho-oreja-amor 1.3s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-oreja-amor{0%,100%{translate:0 0;rotate:calc(-3deg * var(--oreja, 1));}46%{translate:0 -2.4px;rotate:calc(7deg * var(--oreja, 1));}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="poke"] .vp-mochi__ear{animation:vp-mochi-macho-oreja-poke .52s cubic-bezier(.2,.8,.25,1) both;}',
        '@keyframes vp-mochi-macho-oreja-poke{0%{translate:0 0;rotate:calc(0deg * var(--oreja, 1));}22%{translate:0 3.5px;rotate:calc(20deg * var(--oreja, 1));}48%{translate:0 -5.5px;rotate:calc(-15deg * var(--oreja, 1));}72%{translate:0 -1.2px;rotate:calc(5deg * var(--oreja, 1));}100%{translate:0 0;rotate:calc(0deg * var(--oreja, 1));}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="estirando"] .vp-mochi__ear{animation:vp-mochi-macho-oreja-estirar 1.2s cubic-bezier(.45,.05,.35,.95) both;}',
        '@keyframes vp-mochi-macho-oreja-estirar{0%{translate:0 0;rotate:calc(0deg * var(--oreja, 1));}16%{translate:0 2.8px;rotate:calc(19deg * var(--oreja, 1));}42%,66%{translate:0 -3px;rotate:calc(-10.5deg * var(--oreja, 1));}86%{translate:0 .6px;rotate:calc(5deg * var(--oreja, 1));}100%{translate:0 0;rotate:calc(0deg * var(--oreja, 1));}}',

        // ─── 5. CHEEKS (MEJILLAS) ───
        // idle base: 5.2s con pulso sutil de rubor
        '.vp-mochi[data-profile=\"macho\"] .vp-mochi__cheek{animation:vp-mochi-macho-mejilla 5.2s cubic-bezier(.5,.1,.5,1) infinite;}',
        '@keyframes vp-mochi-macho-mejilla{0%,100%{scale:1;opacity:.75;}30%{scale:1.02;opacity:.82;}48%{scale:1.06;opacity:.9;}62%{scale:1.12;opacity:1;}72%{scale:1.05;opacity:.9;}84%{scale:1.02;opacity:.8;}}',
        '.vp-mochi[data-profile=\"macho\"] .vp-mochi__cheek ~ .vp-mochi__cheek{animation-delay:-1.9s;}',

        '.vp-mochi[data-profile=\"macho\"][data-state="pensando"] .vp-mochi__cheek{animation:vp-mochi-macho-mejilla-pensar 2.2s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-mejilla-pensar{0%,100%{scale:1;}45%{scale:1.06;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="leyendo"] .vp-mochi__cheek{animation:vp-mochi-macho-mejilla-leer 1.7s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-mejilla-leer{0%,100%{scale:1;}50%{scale:1.04;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="hablando"] .vp-mochi__cheek{animation:vp-mochi-macho-mejilla-hablar .54s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-mejilla-hablar{0%,100%{scale:1;}45%{scale:1.22;opacity:.95;}72%{scale:1.08;opacity:.85;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="saludando"] .vp-mochi__cheek{animation:vp-mochi-macho-mejilla-saludo .82s cubic-bezier(.34,1.56,.64,1) infinite;}',
        '@keyframes vp-mochi-macho-mejilla-saludo{0%,100%{scale:1;}32%{scale:1.24;}62%{scale:1.06;}82%{scale:1.15;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="somnoliento"] .vp-mochi__cheek{animation:vp-mochi-macho-mejilla-somnoliento 3.4s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-mejilla-somnoliento{0%,100%{scale:.94;opacity:.48;}55%{scale:1.01;opacity:.62;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="durmiendo"] .vp-mochi__cheek{animation:vp-mochi-macho-mejilla-dormir 3.6s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-mejilla-dormir{0%,100%{scale:.9;opacity:.46;}55%{scale:1.03;opacity:.8;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="despidiendo"] .vp-mochi__cheek{animation:vp-mochi-macho-mejilla-despedir .95s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-mejilla-despedir{0%,100%{scale:1;}28%{scale:1.18;}72%{scale:1.09;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="curioso"] .vp-mochi__cheek{animation:vp-mochi-macho-mejilla-curioso 1.4s cubic-bezier(.34,1.56,.64,1) infinite alternate;}',
        '@keyframes vp-mochi-macho-mejilla-curioso{0%{scale:1;}24%{scale:1.12;}48%{scale:1.18;}72%{scale:1.08;}100%{scale:1.04;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="enamorado"] .vp-mochi__cheek{animation:vp-mochi-macho-mejilla-amor 1.3s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-mejilla-amor{0%,100%{scale:1;background:rgba(112,163,217,.42);}14%{scale:1.12;background:rgba(255,150,186,.74);}30%{scale:1.03;background:rgba(244,176,206,.55);}48%{scale:1.22;background:rgba(255,122,170,.92);}72%{scale:1.05;background:rgba(255,170,198,.6);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="poke"] .vp-mochi__cheek{animation:vp-mochi-macho-mejilla-poke .52s cubic-bezier(.2,.8,.25,1) both;}',
        '@keyframes vp-mochi-macho-mejilla-poke{0%{scale:1 1;}26%{scale:1.45 .64;}52%{scale:.84 1.28;}76%{scale:1.08 .94;}100%{scale:1 1;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="estirando"] .vp-mochi__cheek{animation:vp-mochi-macho-mejilla-estirar 1.2s cubic-bezier(.45,.05,.35,.95) both;}',
        '@keyframes vp-mochi-macho-mejilla-estirar{0%{scale:1;}32%,60%{scale:.9;}100%{scale:1;}}',

        // ─── 6. MOUTH (BOCA) ───
        // idle base: respiración casi imperceptible
        '.vp-mochi[data-profile=\"macho\"] .vp-mochi__mouth{animation:vp-mochi-macho-boca-idle 5.2s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-boca-idle{0%,100%{scale:1 .8;}35%{scale:1.03 .85;}70%{scale:.98 .78;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="pensando"] .vp-mochi__mouth{animation:vp-mochi-macho-boca-pensar 2.2s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-boca-pensar{0%,100%{scale:.95 .75;}45%{scale:.9 .68;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="leyendo"] .vp-mochi__mouth{animation:vp-mochi-macho-boca-leyendo 1.7s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-boca-leyendo{0%,100%{scale:1 .95;}50%{scale:1.03 .86;}}',

        // hablando: .27s asimétrico simulando variación fonética
        '.vp-mochi[data-profile=\"macho\"][data-state="hablando"] .vp-mochi__mouth{animation:vp-mochi-macho-boca .27s cubic-bezier(.4,.05,.4,1) infinite;}',
        '@keyframes vp-mochi-macho-boca{0%,100%{scale:1 .78;}18%{scale:1 .62;}32%{scale:1 .48;}45%{scale:1 .4;}58%{scale:1 .52;}72%{scale:1 .72;}86%{scale:1 .65;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="saludando"] .vp-mochi__mouth{animation:vp-mochi-macho-boca-saludo .82s cubic-bezier(.34,1.56,.64,1) infinite;}',
        '@keyframes vp-mochi-macho-boca-saludo{0%,100%{scale:1.05 .9;}32%{scale:1.14 1.18;}62%{scale:1.05 .94;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="somnoliento"] .vp-mochi__mouth{animation:vp-mochi-macho-boca-somnoliento 6.8s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-boca-somnoliento{0%,100%{scale:1 .75;}45%{scale:1.02 .8;}75%{scale:1.18 1.55;}90%{scale:1.05 .9;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="durmiendo"] .vp-mochi__mouth{animation:vp-mochi-macho-boca-dormir 3.6s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-boca-dormir{0%,100%{scale:1 .68;}55%{scale:1.06 .86;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="despidiendo"] .vp-mochi__mouth{animation:vp-mochi-macho-boca-despedir .95s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-boca-despedir{0%,100%{scale:1.05 .9;}28%{scale:1.12 1.12;}72%{scale:1.05 .95;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="curioso"] .vp-mochi__mouth{animation:vp-mochi-macho-boca-curioso 1.4s cubic-bezier(.34,1.56,.64,1) infinite alternate;}',
        '@keyframes vp-mochi-macho-boca-curioso{0%{scale:1 1;}24%{scale:.92 1.2;}46%{scale:.88 1.28;}72%{scale:1.02 1.08;}100%{scale:1 .96;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="enamorado"] .vp-mochi__mouth{animation:vp-mochi-macho-boca-amor 1.3s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-boca-amor{0%,100%{scale:1.04 .9;}46%{scale:1.12 1.08;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="poke"] .vp-mochi__mouth{animation:vp-mochi-macho-boca-poke .52s cubic-bezier(.2,.8,.25,1) both;}',
        '@keyframes vp-mochi-macho-boca-poke{0%{scale:1 1;}28%{scale:1.18 1.55;}52%{scale:.88 .78;}100%{scale:1 1;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="estirando"] .vp-mochi__mouth{animation:vp-mochi-macho-bostezo 1.2s cubic-bezier(.45,.05,.35,.95) both;}',
        '@keyframes vp-mochi-macho-bostezo{0%{scale:1 1;}16%{scale:1.06 .76;}38%,62%{scale:1.24 1.75;}84%{scale:1.04 .86;}100%{scale:1 1;}}',

        // ─── 7. BOWTIE (MOÑO / CORBATA) ───
        '.vp-mochi[data-profile=\"macho\"] .vp-mochi__bowtie{animation:vp-mochi-macho-corbata 2.6s cubic-bezier(.4,.1,.4,1) infinite;transform-origin:50% 18%;}',
        '.vp-mochi[data-profile=\"macho\"][data-state="idle"] .vp-mochi__bowtie{animation:vp-mochi-macho-corbata 2.6s cubic-bezier(.4,.1,.4,1) infinite;transform-origin:50% 18%;}',
        '@keyframes vp-mochi-macho-corbata{0%,100%{transform:translateX(-50%) rotate(-6deg) translateY(0px);}50%{transform:translateX(-50%) rotate(8deg) translateY(1.2px);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="pensando"] .vp-mochi__bowtie{animation:vp-mochi-macho-corbata-pensar 2.2s cubic-bezier(.45,.05,.35,.95) infinite;transform-origin:50% 18%;}',
        '@keyframes vp-mochi-macho-corbata-pensar{0%,100%{transform:translateX(-50%) rotate(-4deg) translateY(0px);}42%{transform:translateX(-50%) rotate(7deg) translateY(-1px);}72%{transform:translateX(-50%) rotate(12deg) translateY(0px);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="leyendo"] .vp-mochi__bowtie{animation:vp-mochi-macho-corbata-leer 1.7s cubic-bezier(.45,.05,.35,.95) infinite;transform-origin:50% 18%;}',
        '@keyframes vp-mochi-macho-corbata-leer{0%,100%{transform:translateX(-50%) rotate(-3deg) translateY(0px);}50%{transform:translateX(-50%) rotate(4deg) translateY(.6px);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="hablando"] .vp-mochi__bowtie{animation:vp-mochi-macho-corbata-hablar .54s cubic-bezier(.4,.05,.4,1) infinite;transform-origin:50% 18%;}',
        '@keyframes vp-mochi-macho-corbata-hablar{0%,100%{transform:translateX(-50%) rotate(-8deg) translateY(0px);}45%{transform:translateX(-50%) rotate(11deg) translateY(-1.8px);}78%{transform:translateX(-50%) rotate(1deg) translateY(0px);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="saludando"] .vp-mochi__bowtie{animation:vp-mochi-macho-corbata-saludo .82s cubic-bezier(.34,1.56,.64,1) infinite;transform-origin:50% 18%;}',
        '.vp-mochi[data-profile=\"macho\"][data-state="despidiendo"] .vp-mochi__bowtie{animation:vp-mochi-macho-corbata-saludo .95s cubic-bezier(.34,1.56,.64,1) infinite;transform-origin:50% 18%;}',
        '@keyframes vp-mochi-macho-corbata-saludo{0%,100%{transform:translateX(-50%) rotate(0deg) translateY(0px) scale(1,1);}14%{transform:translateX(-50%) rotate(-10deg) translateY(1.2px) scale(1.06,.9);}34%{transform:translateX(-50%) rotate(19deg) translateY(-1.8px) scale(1.16,1.12);}58%{transform:translateX(-50%) rotate(-17deg) translateY(0px) scale(1.09,1.04);}80%{transform:translateX(-50%) rotate(7deg) translateY(0px) scale(1.02,1);}92%{transform:translateX(-50%) rotate(-2deg) translateY(0px) scale(1,1);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="somnoliento"] .vp-mochi__bowtie{animation:vp-mochi-macho-corbata-somnoliento 3.4s cubic-bezier(.45,.05,.35,.95) infinite;transform-origin:50% 18%;}',
        '@keyframes vp-mochi-macho-corbata-somnoliento{0%,100%{transform:translateX(-50%) rotate(-2deg) translateY(.6px);}50%{transform:translateX(-50%) rotate(2.5deg) translateY(1.2px);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="durmiendo"] .vp-mochi__bowtie{animation:vp-mochi-macho-corbata-dormir 3.6s cubic-bezier(.45,.05,.35,.95) infinite;transform-origin:50% 18%;}',
        '@keyframes vp-mochi-macho-corbata-dormir{0%,100%{transform:translateX(-50%) rotate(-2deg) translateY(1.2px);}55%{transform:translateX(-50%) rotate(3.5deg) translateY(2.8px);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="curioso"] .vp-mochi__bowtie{animation:vp-mochi-macho-corbata-curioso 1.4s cubic-bezier(.34,1.56,.64,1) infinite alternate;transform-origin:50% 18%;}',
        '@keyframes vp-mochi-macho-corbata-curioso{0%{transform:translateX(-50%) rotate(0deg) translateY(0px);}24%{transform:translateX(-50%) rotate(8deg) translateY(-1.2px);}52%{transform:translateX(-50%) rotate(14deg) translateY(-2px);}78%{transform:translateX(-50%) rotate(6deg) translateY(-.8px);}100%{transform:translateX(-50%) rotate(3deg) translateY(-.2px);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="enamorado"] .vp-mochi__bowtie{animation:vp-mochi-macho-corbata-amor 1.3s cubic-bezier(.45,.05,.35,.95) infinite;transform-origin:50% 18%;}',
        '@keyframes vp-mochi-macho-corbata-amor{0%,100%{transform:translateX(-50%) rotate(-4deg) translateY(0px) scale(1,1);}16%{transform:translateX(-50%) rotate(7deg) translateY(-1.2px) scale(1.09,1.05);}32%{transform:translateX(-50%) rotate(0deg) translateY(0px) scale(1,1);}50%{transform:translateX(-50%) rotate(-9deg) translateY(-1.2px) scale(1.16,1.1);}74%{transform:translateX(-50%) rotate(2.5deg) translateY(0px) scale(1.02,1);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="poke"] .vp-mochi__bowtie{animation:vp-mochi-macho-corbata-poke .52s cubic-bezier(.2,.8,.25,1) both;transform-origin:50% 18%;}',
        '@keyframes vp-mochi-macho-corbata-poke{0%{transform:translateX(-50%) rotate(0deg) translateY(0px) scale(1,1);}24%{transform:translateX(-50%) rotate(-22deg) translateY(1.2px) scale(1.32,.7);}50%{transform:translateX(-50%) rotate(18deg) translateY(-3px) scale(.88,1.25);}76%{transform:translateX(-50%) rotate(-4deg) translateY(0px) scale(1.03,.96);}100%{transform:translateX(-50%) rotate(0deg) translateY(0px) scale(1,1);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="estirando"] .vp-mochi__bowtie{animation:vp-mochi-macho-corbata-estirar 1.2s cubic-bezier(.45,.05,.35,.95) both;transform-origin:50% 18%;}',
        '@keyframes vp-mochi-macho-corbata-estirar{0%{transform:translateX(-50%) rotate(0deg) translateY(0px);}18%{transform:translateX(-50%) rotate(-8deg) translateY(2.8px);}44%{transform:translateX(-50%) rotate(10.5deg) translateY(-2.8px);}70%{transform:translateX(-50%) rotate(-3deg) translateY(-1.2px);}100%{transform:translateX(-50%) rotate(0deg) translateY(0px);}}',

        // ─── 8. EYES (eye / ojo / ojos) ───
        // idle base: 7.4s con 3 tipos de parpadeo (incluyendo doble blink natural)
        '.vp-mochi[data-profile=\"macho\"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"] .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"] .vp-mochi__ojos{animation:vp-mochi-macho-parpadeo 7.4s cubic-bezier(.5,0,.5,1) infinite;transform-origin:50% 55%;}',
        '@keyframes vp-mochi-macho-parpadeo{0%,7%,100%{scale:1 1;}8.4%{scale:1 .08;}9.6%{scale:1 .55;}10.8%{scale:1 1;}38%,40.5%{scale:1 1;}39.2%{scale:1 .08;}40%{scale:1 .5;}72%,76%{scale:1 1;}73%{scale:1 .08;}73.8%{scale:1 .35;}74.4%{scale:1 .08;}75.2%{scale:1 1;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="pensando"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-state="pensando"] .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-state="pensando"] .vp-mochi__ojos{animation:vp-mochi-macho-ojos-pensar 2.2s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-ojos-pensar{0%,100%{scale:1 .9;}40%,60%{scale:1 .76;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="leyendo"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-state="leyendo"] .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-state="leyendo"] .vp-mochi__ojos{animation:vp-mochi-macho-ojos-leer 1.7s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-ojos-leer{0%,100%{scale:1 .8;}30%{scale:1 .72;}60%{scale:1 .84;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="hablando"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-state="hablando"] .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-state="hablando"] .vp-mochi__ojos{animation:vp-mochi-macho-ojos-hablar .54s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-ojos-hablar{0%,100%{scale:1 1;}25%{scale:1.03 1.08;}55%{scale:1 .92;}80%{scale:1 1;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="saludando"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-state="saludando"] .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-state="saludando"] .vp-mochi__ojos{animation:vp-mochi-macho-ojos-saludo .82s cubic-bezier(.34,1.56,.64,1) infinite;}',
        '@keyframes vp-mochi-macho-ojos-saludo{0%,100%{scale:1 .9;}32%{scale:1.05 .76;}62%{scale:1 .95;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="somnoliento"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-state="somnoliento"] .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-state="somnoliento"] .vp-mochi__ojos{transform-origin:center bottom;animation:vp-mochi-macho-ojos-somnoliento 3.4s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-ojos-somnoliento{0%,100%{scale:1 .68;}30%{scale:1 .42;}45%,55%{scale:1 .1;}72%{scale:1 .52;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="durmiendo"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-state="durmiendo"] .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-state="durmiendo"] .vp-mochi__ojos{animation:vp-mochi-macho-ojos-dormir 3.6s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-ojos-dormir{0%,100%{scale:1 .12;}55%{scale:1 .24;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="despidiendo"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-state="despidiendo"] .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-state="despidiendo"] .vp-mochi__ojos{animation:vp-mochi-macho-ojos-despedir .95s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-ojos-despedir{0%,100%{scale:1 .9;}28%{scale:1.04 .78;}72%{scale:1 .84;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="curioso"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-state="curioso"] .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-state="curioso"] .vp-mochi__ojos{animation:vp-mochi-macho-ojos-curioso 1.4s cubic-bezier(.34,1.56,.64,1) infinite alternate;}',
        '@keyframes vp-mochi-macho-ojos-curioso{0%{scale:1 1;}20%{scale:1.05 1.12;}42%{scale:1.1 1.18;}68%{scale:1.04 1.08;}100%{scale:1.02 1.04;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="enamorado"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-state="enamorado"] .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-state="enamorado"] .vp-mochi__ojos{animation:vp-mochi-macho-ojos-amor 1.3s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-ojos-amor{0%,100%{scale:1 .76;}16%{scale:1.05 .56;}34%{scale:1 .82;}50%{scale:1.08 .5;}72%{scale:1 .72;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="poke"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-state="poke"] .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-state="poke"] .vp-mochi__ojos{animation:vp-mochi-macho-ojos-poke .52s cubic-bezier(.2,.8,.25,1) both;}',
        '@keyframes vp-mochi-macho-ojos-poke{0%{scale:1 1;}12%{scale:1.18 1.3;}34%{scale:1 .08;}56%{scale:1.12 1.22;}80%{scale:1 .95;}100%{scale:1 1;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="estirando"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-state="estirando"] .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-state="estirando"] .vp-mochi__ojos{animation:vp-mochi-macho-ojos-estirar 1.2s cubic-bezier(.45,.05,.35,.95) both;}',
        '@keyframes vp-mochi-macho-ojos-estirar{0%{scale:1 1;}14%{scale:1 .82;}32%,60%{scale:1 .2;}82%{scale:1 .88;}100%{scale:1 1;}}',

        // ─── 9. PUPILS (pupil / pupila) ───
        // idle base: 5.2s con movimientos tipo "sacada" (snapping biológico)
        '.vp-mochi[data-profile=\"macho\"] .vp-mochi__pupil,.vp-mochi[data-profile=\"macho\"] .vp-mochi__pupila{animation:vp-mochi-macho-mirar-idle 5.2s cubic-bezier(.7,0,.3,1) infinite;}',
        '@keyframes vp-mochi-macho-mirar-idle{0%,18%,100%{translate:0 0;}20%{translate:1.2px -.4px;}38%,50%{translate:1.2px -.4px;}52%{translate:-1px .2px;}64%,72%{translate:-1px .2px;}74%{translate:.4px -.6px;}84%{translate:.4px -.6px;}86%{translate:0 0;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="pensando"] .vp-mochi__pupil,.vp-mochi[data-profile=\"macho\"][data-state="pensando"] .vp-mochi__pupila{animation:vp-mochi-macho-mirar 2.2s cubic-bezier(.7,0,.3,1) infinite;}',
        '@keyframes vp-mochi-macho-mirar{0%,100%{translate:0 0;}30%{translate:-1.2px -.6px;}55%{translate:-2px -1.3px;}80%{translate:1.2px .4px;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="leyendo"] .vp-mochi__pupil,.vp-mochi[data-profile=\"macho\"][data-state="leyendo"] .vp-mochi__pupila{animation:vp-mochi-macho-mirar-leyendo 1.7s cubic-bezier(.7,0,.3,1) infinite;}',
        '@keyframes vp-mochi-macho-mirar-leyendo{0%,100%{translate:0 0;}12%{translate:-1.4px 0;}70%{translate:1.4px 0;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="hablando"] .vp-mochi__pupil,.vp-mochi[data-profile=\"macho\"][data-state="hablando"] .vp-mochi__pupila{animation:vp-mochi-macho-mirar-hablar .54s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-mirar-hablar{0%,100%{translate:0 0;}35%{translate:1px -.6px;}70%{translate:-1px .4px;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="saludando"] .vp-mochi__pupil,.vp-mochi[data-profile=\"macho\"][data-state="saludando"] .vp-mochi__pupila{animation:vp-mochi-macho-mirar-saludo .82s cubic-bezier(.34,1.56,.64,1) infinite;}',
        '@keyframes vp-mochi-macho-mirar-saludo{0%,100%{translate:0 0;}32%{translate:.9px -.7px;}62%{translate:-.6px -.3px;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="somnoliento"] .vp-mochi__pupil,.vp-mochi[data-profile=\"macho\"][data-state="somnoliento"] .vp-mochi__pupila{animation:vp-mochi-macho-mirar-somnoliento 3.4s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-mirar-somnoliento{0%,100%{scale:1.06;}50%{scale:.94;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="durmiendo"] .vp-mochi__pupil,.vp-mochi[data-profile=\"macho\"][data-state="durmiendo"] .vp-mochi__pupila{animation:vp-mochi-macho-mirar-dormir 3.6s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-mirar-dormir{0%,100%{scale:.9;translate:0 .5px;}55%{scale:1.02;translate:0 .9px;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="despidiendo"] .vp-mochi__pupil,.vp-mochi[data-profile=\"macho\"][data-state="despidiendo"] .vp-mochi__pupila{animation:vp-mochi-macho-mirar-despedir .95s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-mirar-despedir{0%,100%{translate:0 0;}28%{translate:1.2px -.5px;}72%{translate:-1.2px -.3px;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="curioso"] .vp-mochi__pupil,.vp-mochi[data-profile=\"macho\"][data-state="curioso"] .vp-mochi__pupila{animation:vp-mochi-macho-mirar-curioso 1.4s cubic-bezier(.34,1.56,.64,1) infinite alternate;}',
        '@keyframes vp-mochi-macho-mirar-curioso{0%{translate:0 0;}22%{translate:1.8px -1.4px;scale:1.05;}48%{translate:2.2px -1.1px;scale:1.08;}74%{translate:1.1px -.4px;scale:1.04;}100%{translate:1.6px -.9px;scale:1.06;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="enamorado"] .vp-mochi__pupil,.vp-mochi[data-profile=\"macho\"][data-state="enamorado"] .vp-mochi__pupila{animation:vp-mochi-macho-mirar-amor 1.3s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-mirar-amor{0%,100%{scale:1.1;translate:0 0;}46%{scale:1.24;translate:0 -.5px;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="poke"] .vp-mochi__pupil,.vp-mochi[data-profile=\"macho\"][data-state="poke"] .vp-mochi__pupila{animation:vp-mochi-macho-mirar-poke .52s cubic-bezier(.2,.8,.25,1) both;}',
        '@keyframes vp-mochi-macho-mirar-poke{0%{scale:1;}28%{scale:.65;}52%{scale:1.35;}100%{scale:1;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="estirando"] .vp-mochi__pupil,.vp-mochi[data-profile=\"macho\"][data-state="estirando"] .vp-mochi__pupila{animation:vp-mochi-macho-mirar-estirar 1.2s cubic-bezier(.45,.05,.35,.95) both;}',
        '@keyframes vp-mochi-macho-mirar-estirar{0%{scale:1;}32%,60%{scale:.75;}100%{scale:1;}}',

        // ─── 10. NOSE (nariz / nose) ───
        '.vp-mochi[data-profile=\"macho\"][data-state="pensando"] .vp-mochi__nariz,.vp-mochi[data-profile=\"macho\"][data-state="pensando"] .vp-mochi__nose{animation:vp-mochi-macho-nariz-pensar 2.2s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-nariz-pensar{0%,100%{translate:0 0;}45%{translate:0 -.5px;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="leyendo"] .vp-mochi__nariz,.vp-mochi[data-profile=\"macho\"][data-state="leyendo"] .vp-mochi__nose{animation:vp-mochi-macho-nariz-leer 1.7s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-nariz-leer{0%,100%{translate:0 0;}50%{translate:0 .4px;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="hablando"] .vp-mochi__nariz,.vp-mochi[data-profile=\"macho\"][data-state="hablando"] .vp-mochi__nose{animation:vp-mochi-macho-nariz .27s cubic-bezier(.4,.05,.4,1) infinite;}',
        '@keyframes vp-mochi-macho-nariz{0%,100%{translate:0 0;}35%{translate:0 .6px;}65%{translate:0 1px;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="saludando"] .vp-mochi__nariz,.vp-mochi[data-profile=\"macho\"][data-state="saludando"] .vp-mochi__nose{animation:vp-mochi-macho-nariz-saludo .82s cubic-bezier(.34,1.56,.64,1) infinite;}',
        '@keyframes vp-mochi-macho-nariz-saludo{0%,100%{translate:0 0;}32%{translate:0 -.6px;}62%{translate:0 .4px;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="somnoliento"] .vp-mochi__nariz,.vp-mochi[data-profile=\"macho\"][data-state="somnoliento"] .vp-mochi__nose{animation:vp-mochi-macho-nariz-somnoliento 3.4s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-nariz-somnoliento{0%,100%{translate:0 0;scale:1;}50%{translate:0 .5px;scale:1.04;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="durmiendo"] .vp-mochi__nariz,.vp-mochi[data-profile=\"macho\"][data-state="durmiendo"] .vp-mochi__nose{animation:vp-mochi-macho-nariz-dormir 3.6s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-nariz-dormir{0%,100%{translate:0 0;scale:.96;}55%{translate:0 .9px;scale:1.06;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="despidiendo"] .vp-mochi__nariz,.vp-mochi[data-profile=\"macho\"][data-state="despidiendo"] .vp-mochi__nose{animation:vp-mochi-macho-nariz-despedir .95s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-nariz-despedir{0%,100%{translate:0 0;}28%{translate:0 -.6px;}72%{translate:0 .5px;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="curioso"] .vp-mochi__nariz,.vp-mochi[data-profile=\"macho\"][data-state="curioso"] .vp-mochi__nose{animation:vp-mochi-macho-nariz-curioso 1.4s cubic-bezier(.34,1.56,.64,1) infinite alternate;}',
        '@keyframes vp-mochi-macho-nariz-curioso{0%{translate:0 0;}18%{translate:.6px -.8px;}42%{translate:.9px -.9px;}72%{translate:.5px -.5px;}100%{translate:.4px -.4px;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="enamorado"] .vp-mochi__nariz,.vp-mochi[data-profile=\"macho\"][data-state="enamorado"] .vp-mochi__nose{animation:vp-mochi-macho-nariz-amor 1.3s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-nariz-amor{0%,100%{translate:0 0;}46%{translate:0 -.7px;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="poke"] .vp-mochi__nariz,.vp-mochi[data-profile=\"macho\"][data-state="poke"] .vp-mochi__nose{animation:vp-mochi-macho-nariz-poke .52s cubic-bezier(.2,.8,.25,1) both;}',
        '@keyframes vp-mochi-macho-nariz-poke{0%{translate:0 0;scale:1;}28%{translate:0 1px;scale:1.18;}52%{translate:0 -.7px;scale:1;}100%{translate:0 0;scale:1;}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="estirando"] .vp-mochi__nariz,.vp-mochi[data-profile=\"macho\"][data-state="estirando"] .vp-mochi__nose{animation:vp-mochi-macho-nariz-estirar 1.2s cubic-bezier(.45,.05,.35,.95) both;}',
        '@keyframes vp-mochi-macho-nariz-estirar{0%{translate:0 0;scale:1;}38%,62%{translate:0 -.9px;scale:1.12;}100%{translate:0 0;scale:1;}}',

        // ─── 11. PARTÍCULAS ───
        '.vp-mochi[data-profile=\"macho\"] .vp-mochi__particle{filter:hue-rotate(155deg) saturate(1.2) brightness(1.08) drop-shadow(0 2px 5px rgba(47,93,150,.38));}',

        '.vp-mochi[data-profile=\"macho\"][data-state="enamorado"] .vp-mochi__particle{animation:vp-mochi-macho-particula-amor 1.3s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-particula-amor{0%,100%{scale:1;filter:hue-rotate(155deg) saturate(1.2) brightness(1.08) drop-shadow(0 2px 5px rgba(47,93,150,.38));}46%{scale:1.18;filter:hue-rotate(215deg) saturate(1.5) brightness(1.2) drop-shadow(0 2px 7px rgba(255,120,170,.5));}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="saludando"] .vp-mochi__particle{animation:vp-mochi-macho-particula-saludo .82s cubic-bezier(.34,1.56,.64,1) infinite;}',
        '@keyframes vp-mochi-macho-particula-saludo{0%,100%{scale:1;filter:hue-rotate(155deg) saturate(1.2) brightness(1.08) drop-shadow(0 2px 5px rgba(47,93,150,.38));}32%{scale:1.15;filter:hue-rotate(175deg) saturate(1.3) brightness(1.15) drop-shadow(0 2px 6px rgba(47,93,150,.45));}}',

        // ─── 12. MOODS ───
        // — triste —
        '.vp-mochi[data-profile=\"macho\"][data-mood="triste"][data-state="hablando"] .vp-mochi__body{animation:vp-mochi-macho-humor-triste 1.25s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-humor-triste{0%,100%{transform:translateY(2px) rotate(0) scale(.98,1.02);}50%{transform:translateY(4.5px) rotate(-3.5deg) scale(.96,1.035);}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="triste"][data-state="hablando"] .vp-mochi__tail{animation:vp-mochi-macho-cola-triste 1.25s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-cola-triste{0%,100%{transform:rotate(-14deg) scale(.98,1);}20%{transform:rotate(-13deg) scale(.98,1);}40%{transform:rotate(-15.5deg) scale(.98,1);}60%{transform:rotate(-13.5deg) scale(.98,1);}80%{transform:rotate(-15deg) scale(.98,1);}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="triste"][data-state="hablando"] .vp-mochi__ear{animation:vp-mochi-macho-oreja-triste 1.25s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-oreja-triste{0%,100%{translate:0 2.2px;rotate:calc(22deg * var(--oreja, 1));}50%{translate:0 3.4px;rotate:calc(18deg * var(--oreja, 1));}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="triste"][data-state="hablando"] .vp-mochi__cheek{animation:vp-mochi-macho-mejilla-triste 1.25s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-mejilla-triste{0%,100%{scale:.95;opacity:.55;background:rgba(160,190,220,.3);}50%{scale:.91;opacity:.48;background:rgba(160,190,220,.24);}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="triste"][data-state="hablando"] .vp-mochi__mouth{animation:vp-mochi-macho-boca-triste 1.25s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-boca-triste{0%,100%{scale:1.05 .7;translate:0 1px;}50%{scale:1.05 .88;translate:0 1.8px;}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="triste"][data-state="hablando"] .vp-mochi__bowtie{animation:vp-mochi-macho-corbata-triste 1.25s cubic-bezier(.45,.05,.35,.95) infinite;transform-origin:50% 18%;}',
        '@keyframes vp-mochi-macho-corbata-triste{0%,100%{transform:translateX(-50%) rotate(-10deg) translateY(2px);}50%{transform:translateX(-50%) rotate(-7.5deg) translateY(3.2px);}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="triste"][data-state="hablando"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-mood="triste"][data-state="hablando"] .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-mood="triste"][data-state="hablando"] .vp-mochi__ojos{animation:vp-mochi-macho-ojos-humor-triste 1.25s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-ojos-humor-triste{0%,100%{scale:1 .6;}50%{scale:1 .55;}}',

        // — enojado —
        '.vp-mochi[data-profile=\"macho\"][data-mood="enojado"][data-state="hablando"] .vp-mochi__body{animation:vp-mochi-macho-humor-enojado .42s cubic-bezier(.25,1,.5,1) infinite;}',
        '@keyframes vp-mochi-macho-humor-enojado{0%,100%{transform:translateX(0) rotate(0);}25%{transform:translateX(-2.5px) rotate(-2.5deg);}75%{transform:translateX(2.5px) rotate(2.5deg);}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="enojado"][data-state="hablando"] .vp-mochi__tail{animation:vp-mochi-macho-cola-enojado .28s cubic-bezier(.34,1.56,.64,1) infinite;}',
        '@keyframes vp-mochi-macho-cola-enojado{0%,100%{transform:rotate(-6deg) scale(1.03,.97);}50%{transform:rotate(28deg) scale(1.1,.92);}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="enojado"][data-state="hablando"] .vp-mochi__ear{animation:vp-mochi-macho-oreja-enojado .42s cubic-bezier(.25,1,.5,1) infinite;}',
        '@keyframes vp-mochi-macho-oreja-enojado{0%,100%{translate:0 1.2px;rotate:calc(-19deg * var(--oreja, 1));}50%{translate:0 1.8px;rotate:calc(-22deg * var(--oreja, 1));}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="enojado"][data-state="hablando"] .vp-mochi__cheek{animation:vp-mochi-macho-mejilla-enojado .42s cubic-bezier(.25,1,.5,1) infinite;}',
        '@keyframes vp-mochi-macho-mejilla-enojado{0%,100%{scale:1.12;background:rgba(226,72,72,.58);}50%{scale:1.18;background:rgba(226,60,60,.72);}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="enojado"][data-state="hablando"] .vp-mochi__mouth{animation:vp-mochi-macho-boca-enojado .42s cubic-bezier(.25,1,.5,1) infinite;}',
        '@keyframes vp-mochi-macho-boca-enojado{0%,100%{scale:1.12 .58;}50%{scale:1.12 .7;}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="enojado"][data-state="hablando"] .vp-mochi__bowtie{animation:vp-mochi-macho-corbata-enojado .42s cubic-bezier(.25,1,.5,1) infinite;transform-origin:50% 18%;}',
        '@keyframes vp-mochi-macho-corbata-enojado{0%,100%{transform:translateX(-50%) rotate(-3.5deg) translateY(0px) scale(1.07,1.04);}50%{transform:translateX(-50%) rotate(3.5deg) translateY(-.6px) scale(1.07,1.04);}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="enojado"][data-state="hablando"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-mood="enojado"][data-state="hablando"] .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-mood="enojado"][data-state="hablando"] .vp-mochi__ojos{animation:vp-mochi-macho-ojos-humor-enojado .42s cubic-bezier(.25,1,.5,1) infinite;}',
        '@keyframes vp-mochi-macho-ojos-humor-enojado{0%,100%{scale:1 .7;rotate:-9deg;}50%{scale:1 .65;rotate:-9deg;}}',

        // — feliz —
        '.vp-mochi[data-profile=\"macho\"][data-mood="feliz"][data-state="hablando"] .vp-mochi__body{animation:vp-mochi-macho-humor-feliz .55s cubic-bezier(.34,1.56,.64,1) infinite;}',
        '@keyframes vp-mochi-macho-humor-feliz{0%,100%{transform:translateY(0) scale(1);}35%{transform:translateY(-6px) scale(1.05,.95);}65%{transform:translateY(0) scale(.98,1.02);}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="feliz"][data-state="hablando"] .vp-mochi__tail{animation:vp-mochi-macho-cola-feliz .55s cubic-bezier(.34,1.56,.64,1) infinite;}',
        '@keyframes vp-mochi-macho-cola-feliz{0%,100%{transform:rotate(-18deg) scale(1,1);}50%{transform:rotate(32deg) scale(1.14,.92);}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="feliz"][data-state="hablando"] .vp-mochi__ear{animation:vp-mochi-macho-oreja-feliz .55s cubic-bezier(.34,1.56,.64,1) infinite;}',
        '@keyframes vp-mochi-macho-oreja-feliz{0%,100%{translate:0 -2.4px;rotate:calc(-9deg * var(--oreja, 1));}35%{translate:0 -4.5px;rotate:calc(-14deg * var(--oreja, 1));}65%{translate:0 -1.8px;rotate:calc(-6deg * var(--oreja, 1));}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="feliz"][data-state="hablando"] .vp-mochi__cheek{animation:vp-mochi-macho-mejilla-feliz .55s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-mejilla-feliz{0%,100%{scale:1.1;background:rgba(255,160,190,.58);}50%{scale:1.2;background:rgba(255,140,180,.72);}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="feliz"][data-state="hablando"] .vp-mochi__mouth{animation:vp-mochi-macho-boca-feliz .55s cubic-bezier(.4,.05,.4,1) infinite;}',
        '@keyframes vp-mochi-macho-boca-feliz{0%,100%{scale:1.18 1.35;}50%{scale:1.12 1.05;}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="feliz"][data-state="hablando"] .vp-mochi__bowtie{animation:vp-mochi-macho-corbata-feliz .55s cubic-bezier(.34,1.56,.64,1) infinite;transform-origin:50% 18%;}',
        '@keyframes vp-mochi-macho-corbata-feliz{0%,100%{transform:translateX(-50%) rotate(-15deg) translateY(0px);}50%{transform:translateX(-50%) rotate(15deg) translateY(-1.8px);}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="feliz"][data-state="hablando"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-mood="feliz"][data-state="hablando"] .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-mood="feliz"][data-state="hablando"] .vp-mochi__ojos{animation:vp-mochi-macho-ojos-humor-feliz .55s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-ojos-humor-feliz{0%,100%{scale:1 .6;}50%{scale:1.05 .48;}}',

        // — epico —
        '.vp-mochi[data-profile=\"macho\"][data-mood="epico"]:is([data-state="hablando"],[data-state="leyendo"]) .vp-mochi__body{animation:vp-mochi-macho-humor-epico 1.8s cubic-bezier(.34,1.56,.64,1) infinite;}',
        '@keyframes vp-mochi-macho-humor-epico{0%,100%{transform:translateY(0) scale(1,1);}38%{transform:translateY(-13.5px) scale(1.07,.93);}55%{transform:translateY(-11px) scale(1.02,.98);}78%{transform:translateY(-2.5px) scale(.99,1.02);}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="epico"]:is([data-state="hablando"],[data-state="leyendo"]) .vp-mochi__tail{animation:vp-mochi-macho-cola-epico 1.8s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-cola-epico{0%,100%{transform:rotate(-14deg) scale(1,1);}42%{transform:rotate(12deg) scale(1.05,.97);}68%{transform:rotate(30deg) scale(1.1,.94);}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="epico"]:is([data-state="hablando"],[data-state="leyendo"]) .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-mood="epico"]:is([data-state="hablando"],[data-state="leyendo"]) .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-mood="epico"]:is([data-state="hablando"],[data-state="leyendo"]) .vp-mochi__ojos{animation:vp-mochi-macho-ojos-humor-epico 1.8s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-ojos-humor-epico{0%,100%{scale:1 1;}40%{scale:1.1 .8;}58%{scale:1.05 .88;}}',

        // — gracioso —
        '.vp-mochi[data-profile=\"macho\"][data-mood="gracioso"]:is([data-state="hablando"],[data-state="leyendo"]) .vp-mochi__body{animation:vp-mochi-macho-humor-gracioso .7s cubic-bezier(.34,1.56,.64,1) infinite;}',
        '@keyframes vp-mochi-macho-humor-gracioso{0%,100%{transform:translateY(0) scale(1,1);}16%{transform:translateY(-9px) scale(1.09,.91);}32%{transform:translateY(0) scale(.95,1.07);}48%{transform:translateY(-12px) scale(1.12,.88);}66%{transform:translateY(0) scale(.97,1.05);}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="gracioso"]:is([data-state="hablando"],[data-state="leyendo"]) .vp-mochi__tail{animation:vp-mochi-macho-cola-gracioso .7s cubic-bezier(.34,1.56,.64,1) infinite;}',
        '@keyframes vp-mochi-macho-cola-gracioso{0%,100%{transform:rotate(-14deg) scale(1,1);}20%{transform:rotate(32deg) scale(1.14,.91);}40%{transform:rotate(-9deg) scale(.95,1.05);}58%{transform:rotate(40deg) scale(1.16,.88);}76%{transform:rotate(-4deg) scale(1,1);}}',

        // — sarcastico —
        '.vp-mochi[data-profile=\"macho\"][data-mood="sarcastico"]:is([data-state="hablando"],[data-state="leyendo"]) .vp-mochi__body{animation:vp-mochi-macho-humor-sarcastico 1.4s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-humor-sarcastico{0%,18%,100%{transform:rotate(0deg) translateY(0);}42%,62%{transform:rotate(-9deg) translateY(-2.4px);}82%{transform:rotate(0deg) translateY(0);}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="sarcastico"]:is([data-state="hablando"],[data-state="leyendo"]) .vp-mochi__tail{animation:vp-mochi-macho-cola-sarcastico 1.4s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-cola-sarcastico{0%,18%,100%{transform:rotate(0deg) scale(1,1);}42%,62%{transform:rotate(-18deg) scale(1.04,.97);}82%{transform:rotate(2.5deg) scale(1,1);}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="sarcastico"]:is([data-state="hablando"],[data-state="leyendo"]) .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-mood="sarcastico"]:is([data-state="hablando"],[data-state="leyendo"]) .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-mood="sarcastico"]:is([data-state="hablando"],[data-state="leyendo"]) .vp-mochi__ojos{animation:vp-mochi-macho-ojos-humor-sarcastico 1.4s cubic-bezier(.7,0,.3,1) infinite;}',
        '@keyframes vp-mochi-macho-ojos-humor-sarcastico{0%,18%,100%{rotate:0deg;}42%,62%{rotate:-7deg;}82%{rotate:0deg;}}',

        // — tenso —
        '.vp-mochi[data-profile=\"macho\"][data-mood="tenso"]:is([data-state="hablando"],[data-state="leyendo"]) .vp-mochi__body{animation:vp-mochi-macho-humor-tenso .35s cubic-bezier(.25,1,.5,1) infinite;}',
        '@keyframes vp-mochi-macho-humor-tenso{0%,100%{transform:translateX(0) scale(1,1);}25%{transform:translateX(-2.2px) scale(.985,1.015);}50%{transform:translateX(2.2px) scale(.985,1.015);}75%{transform:translateX(-1.2px) scale(1,1);}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="tenso"]:is([data-state="hablando"],[data-state="leyendo"]) .vp-mochi__tail{animation:vp-mochi-macho-cola-tenso .35s cubic-bezier(.25,1,.5,1) infinite;}',
        '@keyframes vp-mochi-macho-cola-tenso{0%,100%{transform:translateX(0) rotate(0deg) scale(1,1);}25%{transform:translateX(-2px) rotate(-6deg) scale(.97,1.03);}50%{transform:translateX(2px) rotate(6deg) scale(.97,1.03);}75%{transform:translateX(-1px) rotate(-2.5deg) scale(1,1);}}',

        // — intrigado —
        '.vp-mochi[data-profile=\"macho\"][data-mood="intrigado"][data-state="hablando"] .vp-mochi__body{animation:vp-mochi-macho-humor-intrigado .9s cubic-bezier(.34,1.56,.64,1) infinite alternate;}',
        '@keyframes vp-mochi-macho-humor-intrigado{from{transform:rotate(-3.5deg) translateY(0);}to{transform:rotate(3.5deg) translateY(-2.5px);}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="intrigado"][data-state="hablando"] .vp-mochi__tail{animation:vp-mochi-macho-cola-intrigado .9s cubic-bezier(.34,1.56,.64,1) infinite alternate;}',
        '@keyframes vp-mochi-macho-cola-intrigado{from{transform:rotate(4deg) scale(1,1);}to{transform:rotate(24deg) scale(1.06,.96);}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="intrigado"][data-state="hablando"] .vp-mochi__ear{animation:vp-mochi-macho-oreja-intrigado-alta .9s cubic-bezier(.34,1.56,.64,1) infinite alternate;}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="intrigado"][data-state="hablando"] .vp-mochi__ear ~ .vp-mochi__ear{animation:vp-mochi-macho-oreja-intrigado-media .9s cubic-bezier(.34,1.56,.64,1) infinite alternate;}',
        '@keyframes vp-mochi-macho-oreja-intrigado-alta{from{translate:0 -3.2px;rotate:calc(-13deg * var(--oreja, 1));}to{translate:0 -4.8px;rotate:calc(-17deg * var(--oreja, 1));}}',
        '@keyframes vp-mochi-macho-oreja-intrigado-media{from{translate:0 -1px;rotate:calc(-4.5deg * var(--oreja, 1));}to{translate:0 -2px;rotate:calc(-7.5deg * var(--oreja, 1));}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="intrigado"][data-state="hablando"] .vp-mochi__cheek{animation:vp-mochi-macho-mejilla-intrigado .9s cubic-bezier(.45,.05,.35,.95) infinite alternate;}',
        '@keyframes vp-mochi-macho-mejilla-intrigado{from{scale:1;}to{scale:1.06;}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="intrigado"][data-state="hablando"] .vp-mochi__mouth{animation:vp-mochi-macho-boca-intrigado .9s cubic-bezier(.45,.05,.35,.95) infinite alternate;}',
        '@keyframes vp-mochi-macho-boca-intrigado{from{scale:.9 .85;translate:1px 0;}to{scale:.96 1.02;translate:1.6px 0;}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="intrigado"][data-state="hablando"] .vp-mochi__bowtie{animation:vp-mochi-macho-corbata-intrigado .9s cubic-bezier(.34,1.56,.64,1) infinite alternate;transform-origin:50% 18%;}',
        '@keyframes vp-mochi-macho-corbata-intrigado{from{transform:translateX(-50%) rotate(2deg) translateY(0px);}to{transform:translateX(-50%) rotate(11deg) translateY(-1.2px);}}',
        '.vp-mochi[data-profile=\"macho\"][data-mood="intrigado"][data-state="hablando"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-mood="intrigado"][data-state="hablando"] .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-mood="intrigado"][data-state="hablando"] .vp-mochi__ojos{animation:vp-mochi-macho-ojos-humor-intrigado .9s cubic-bezier(.7,0,.3,1) infinite alternate;}',
        '@keyframes vp-mochi-macho-ojos-humor-intrigado{from{scale:1 1;}to{scale:1.08 1.16;}}',

        // ─── 13. NUEVOS ESTADOS ───
        // — acariciado (one-shot .9s) —
        '.vp-mochi[data-profile=\"macho\"][data-state="acariciado"] .vp-mochi__body{animation:vp-mochi-macho-acariciado .9s cubic-bezier(.25,1,.5,1) both;}',
        '@keyframes vp-mochi-macho-acariciado{0%{transform:translateY(0) rotate(0) scale(1,1);}22%{transform:translateY(2.4px) rotate(-1.8deg) scale(1.09,.91);}48%{transform:translateY(0) rotate(1.2deg) scale(1.03,.975);}72%{transform:translateY(1.2px) rotate(-.6deg) scale(1.05,.95);}100%{transform:translateY(.6px) rotate(0) scale(1.03,.97);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="acariciado"] .vp-mochi__tail{animation:vp-mochi-macho-cola-acariciado .9s cubic-bezier(.34,1.56,.64,1) both;}',
        '@keyframes vp-mochi-macho-cola-acariciado{0%{transform:rotate(-8deg) scale(1,1);}16%{transform:rotate(24deg) scale(1.07,.95);}32%{transform:rotate(-7deg) scale(1,1);}48%{transform:rotate(24deg) scale(1.07,.95);}64%{transform:rotate(-4deg) scale(1,1);}80%{transform:rotate(17deg) scale(1.03,.98);}100%{transform:rotate(4.5deg) scale(1,1);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="acariciado"] .vp-mochi__ear{animation:vp-mochi-macho-oreja-acariciado .9s cubic-bezier(.25,1,.5,1) both;}',
        '@keyframes vp-mochi-macho-oreja-acariciado{0%{translate:0 0;rotate:calc(0deg * var(--oreja, 1));}30%{translate:0 1.6px;rotate:calc(10deg * var(--oreja, 1));}60%{translate:0 2.2px;rotate:calc(12deg * var(--oreja, 1));}100%{translate:0 1.6px;rotate:calc(9.5deg * var(--oreja, 1));}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="acariciado"] .vp-mochi__cheek{animation:vp-mochi-macho-mejilla-acariciado .9s cubic-bezier(.25,1,.5,1) both;}',
        '@keyframes vp-mochi-macho-mejilla-acariciado{0%{scale:1;background:rgba(112,163,217,.42);}40%{scale:1.24;background:rgba(255,105,160,.9);}100%{scale:1.16;background:rgba(255,120,170,.82);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="acariciado"] .vp-mochi__mouth{animation:vp-mochi-macho-boca-acariciado .9s cubic-bezier(.25,1,.5,1) both;}',
        '@keyframes vp-mochi-macho-boca-acariciado{0%{scale:1 1;}30%{scale:1.12 .84;}100%{scale:1.09 .88;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="acariciado"] .vp-mochi__bowtie{animation:vp-mochi-macho-corbata-acariciado .9s cubic-bezier(.25,1,.5,1) both;transform-origin:50% 18%;}',
        '@keyframes vp-mochi-macho-corbata-acariciado{0%{transform:translateX(-50%) rotate(0deg) translateY(0px);}30%{transform:translateX(-50%) rotate(-6.5deg) translateY(1.2px);}60%{transform:translateX(-50%) rotate(5.5deg) translateY(0px);}100%{transform:translateX(-50%) rotate(0deg) translateY(.6px);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="acariciado"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-state="acariciado"] .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-state="acariciado"] .vp-mochi__ojos{animation:vp-mochi-macho-ojos-acariciado .9s cubic-bezier(.25,1,.5,1) both;}',
        '@keyframes vp-mochi-macho-ojos-acariciado{0%{scale:1 1;}30%,100%{scale:1 .28;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="acariciado"] .vp-mochi__pupil,.vp-mochi[data-profile=\"macho\"][data-state="acariciado"] .vp-mochi__pupila{animation:vp-mochi-macho-mirar-acariciado .9s cubic-bezier(.25,1,.5,1) both;}',
        '@keyframes vp-mochi-macho-mirar-acariciado{0%{scale:1;translate:0 0;}40%,100%{scale:.88;translate:0 .6px;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="acariciado"] .vp-mochi__nariz,.vp-mochi[data-profile=\"macho\"][data-state="acariciado"] .vp-mochi__nose{animation:vp-mochi-macho-nariz-acariciado .9s cubic-bezier(.25,1,.5,1) both;}',
        '@keyframes vp-mochi-macho-nariz-acariciado{0%{translate:0 0;}40%{translate:0 .6px;}100%{translate:0 .35px;}}',

        // — riendo (infinite .7s) —
        '.vp-mochi[data-profile=\"macho\"][data-state="riendo"] .vp-mochi__body{animation:vp-mochi-macho-reir .7s cubic-bezier(.34,1.56,.64,1) infinite;}',
        '@keyframes vp-mochi-macho-reir{0%,100%{transform:translateY(0) rotate(0) scale(1,1);}12%{transform:translateY(-4.5px) rotate(-3.5deg) scale(.96,1.06);}25%{transform:translateY(1.2px) rotate(0) scale(1.06,.94);}50%{transform:translateY(0) rotate(0) scale(1,1);}62%{transform:translateY(-4.5px) rotate(3.5deg) scale(.96,1.06);}75%{transform:translateY(1.2px) rotate(0) scale(1.06,.94);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="riendo"] .vp-mochi__tail{animation:vp-mochi-macho-cola-reir .35s cubic-bezier(.34,1.56,.64,1) infinite;}',
        '@keyframes vp-mochi-macho-cola-reir{0%,100%{transform:rotate(-15deg) scale(1,1);}50%{transform:rotate(28deg) scale(1.1,.93);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="riendo"] .vp-mochi__ear{animation:vp-mochi-macho-oreja-reir .35s cubic-bezier(.34,1.56,.64,1) infinite;}',
        '@keyframes vp-mochi-macho-oreja-reir{0%,100%{translate:0 0;rotate:calc(-9deg * var(--oreja, 1));}50%{translate:0 -1.8px;rotate:calc(9deg * var(--oreja, 1));}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="riendo"] .vp-mochi__cheek{animation:vp-mochi-macho-mejilla-reir .7s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-mejilla-reir{0%,100%{scale:1.16;background:rgba(255,160,190,.58);}50%{scale:1.28;background:rgba(255,140,180,.74);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="riendo"] .vp-mochi__mouth{animation:vp-mochi-macho-boca-reir .35s cubic-bezier(.4,.05,.4,1) infinite;}',
        '@keyframes vp-mochi-macho-boca-reir{0%,100%{scale:1.16 1.65;}50%{scale:1.1 1.38;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="riendo"] .vp-mochi__bowtie{animation:vp-mochi-macho-corbata-reir .7s cubic-bezier(.34,1.56,.64,1) infinite;transform-origin:50% 18%;}',
        '@keyframes vp-mochi-macho-corbata-reir{0%,100%{transform:translateX(-50%) rotate(-7deg) translateY(0px);}50%{transform:translateX(-50%) rotate(7deg) translateY(-1.2px);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="riendo"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-state="riendo"] .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-state="riendo"] .vp-mochi__ojos{animation:vp-mochi-macho-ojos-reir .7s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-ojos-reir{0%,100%{scale:1 .14;}50%{scale:1.03 .22;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="riendo"] .vp-mochi__pupil,.vp-mochi[data-profile=\"macho\"][data-state="riendo"] .vp-mochi__pupila{animation:vp-mochi-macho-mirar-reir .7s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-mirar-reir{0%,100%{scale:.78;translate:0 0;}50%{scale:.85;translate:0 -.4px;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="riendo"] .vp-mochi__nariz,.vp-mochi[data-profile=\"macho\"][data-state="riendo"] .vp-mochi__nose{animation:vp-mochi-macho-nariz-reir .35s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-nariz-reir{0%,100%{translate:0 0;}50%{translate:0 .9px;}}',

        // — asustado (one-shot .6s) —
        '.vp-mochi[data-profile=\"macho\"][data-state="asustado"] .vp-mochi__body{animation:vp-mochi-macho-asustado .6s cubic-bezier(.25,1,.5,1) both;}',
        '@keyframes vp-mochi-macho-asustado{0%{transform:translateY(0) rotate(0) scale(1,1);}12%{transform:translateY(-7px) rotate(0) scale(.88,1.18);}30%{transform:translateY(-2.5px) rotate(0) scale(.94,1.09);}45%{transform:translateX(-1.8px) translateY(-2px) rotate(-2deg) scale(.94,1.09);}60%{transform:translateX(1.8px) translateY(-2px) rotate(2deg) scale(.94,1.09);}80%{transform:translateX(-1px) translateY(-1px) rotate(-.6deg) scale(.96,1.06);}100%{transform:translateY(-1px) rotate(0) scale(.97,1.04);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="asustado"] .vp-mochi__tail{animation:vp-mochi-macho-cola-asustado .6s cubic-bezier(.25,1,.5,1) both;}',
        '@keyframes vp-mochi-macho-cola-asustado{0%{transform:rotate(-6deg) scale(1,1);}15%{transform:rotate(44deg) scale(1.12,.94);}50%{transform:rotate(40deg) scale(1.07,.96);}75%{transform:rotate(36deg) scale(1.06,.97);}100%{transform:rotate(37deg) scale(1.05,.98);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="asustado"] .vp-mochi__ear{animation:vp-mochi-macho-oreja-asustado .6s cubic-bezier(.25,1,.5,1) both;}',
        '@keyframes vp-mochi-macho-oreja-asustado{0%{translate:0 0;rotate:calc(0deg * var(--oreja, 1));}18%{translate:0 -4.5px;rotate:calc(28deg * var(--oreja, 1));}40%{translate:0 -3.5px;rotate:calc(-28deg * var(--oreja, 1));}60%{translate:0 -3.2px;rotate:calc(22deg * var(--oreja, 1));}100%{translate:0 -2.2px;rotate:calc(20deg * var(--oreja, 1));}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="asustado"] .vp-mochi__cheek{animation:vp-mochi-macho-mejilla-asustado .6s cubic-bezier(.25,1,.5,1) both;}',
        '@keyframes vp-mochi-macho-mejilla-asustado{0%{scale:1;opacity:1;background:rgba(112,163,217,.42);}30%,100%{scale:.9;opacity:.55;background:rgba(160,190,220,.22);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="asustado"] .vp-mochi__mouth{animation:vp-mochi-macho-boca-asustado .6s cubic-bezier(.25,1,.5,1) both;}',
        '@keyframes vp-mochi-macho-boca-asustado{0%{scale:1 1;}14%{scale:.88 1.55;}100%{scale:.94 1.34;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="asustado"] .vp-mochi__bowtie{animation:vp-mochi-macho-corbata-asustado .6s cubic-bezier(.25,1,.5,1) both;transform-origin:50% 18%;}',
        '@keyframes vp-mochi-macho-corbata-asustado{0%{transform:translateX(-50%) rotate(0deg) translateY(0px);}15%{transform:translateX(-50%) rotate(-12deg) translateY(-2.2px);}35%{transform:translateX(-50%) rotate(12deg) translateY(-1.2px);}55%{transform:translateX(-50%) rotate(-7deg) translateY(-1px);}100%{transform:translateX(-50%) rotate(0deg) translateY(-1px);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="asustado"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-state="asustado"] .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-state="asustado"] .vp-mochi__ojos{animation:vp-mochi-macho-ojos-asustado .6s cubic-bezier(.25,1,.5,1) both;}',
        '@keyframes vp-mochi-macho-ojos-asustado{0%{scale:1 1;}14%{scale:1.18 1.34;}100%{scale:1.12 1.24;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="asustado"] .vp-mochi__pupil,.vp-mochi[data-profile=\"macho\"][data-state="asustado"] .vp-mochi__pupila{animation:vp-mochi-macho-mirar-asustado .6s cubic-bezier(.25,1,.5,1) both;}',
        '@keyframes vp-mochi-macho-mirar-asustado{0%{scale:1;}14%,100%{scale:1.45;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="asustado"] .vp-mochi__nariz,.vp-mochi[data-profile=\"macho\"][data-state="asustado"] .vp-mochi__nose{animation:vp-mochi-macho-nariz-asustado .6s cubic-bezier(.25,1,.5,1) both;}',
        '@keyframes vp-mochi-macho-nariz-asustado{0%{translate:0 0;}20%{translate:-.5px 0;}40%{translate:.5px 0;}60%{translate:-.35px 0;}100%{translate:0 0;}}',

        // — sorpresa (one-shot .7s) —
        '.vp-mochi[data-profile=\"macho\"][data-state="sorpresa"] .vp-mochi__body{animation:vp-mochi-macho-sorpresa .7s cubic-bezier(.34,1.56,.64,1) both;}',
        '@keyframes vp-mochi-macho-sorpresa{0%{transform:translateY(0) rotate(0) scale(1,1);}14%{transform:translateY(2.5px) rotate(0) scale(1.18,.82);}38%{transform:translateY(-9.5px) rotate(0) scale(.9,1.16);}62%{transform:translateY(0) rotate(0) scale(1.04,.96);}82%{transform:translateY(-1.2px) rotate(0) scale(.99,1.01);}100%{transform:translateY(0) rotate(0) scale(1,1);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="sorpresa"] .vp-mochi__tail{animation:vp-mochi-macho-cola-sorpresa .7s cubic-bezier(.34,1.56,.64,1) both;}',
        '@keyframes vp-mochi-macho-cola-sorpresa{0%{transform:rotate(-12deg) scale(1,1);}38%{transform:rotate(34deg) scale(1.12,.93);}70%{transform:rotate(14deg) scale(1.03,.98);}100%{transform:rotate(4.5deg) scale(1,1);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="sorpresa"] .vp-mochi__ear{animation:vp-mochi-macho-oreja-sorpresa .7s cubic-bezier(.34,1.56,.64,1) both;}',
        '@keyframes vp-mochi-macho-oreja-sorpresa{0%{translate:0 0;rotate:calc(0deg * var(--oreja, 1));}38%{translate:0 -4.8px;rotate:calc(-16deg * var(--oreja, 1));}70%{translate:0 -2.4px;rotate:calc(-7deg * var(--oreja, 1));}100%{translate:0 0;rotate:calc(0deg * var(--oreja, 1));}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="sorpresa"] .vp-mochi__cheek{animation:vp-mochi-macho-mejilla-sorpresa .7s cubic-bezier(.34,1.56,.64,1) both;}',
        '@keyframes vp-mochi-macho-mejilla-sorpresa{0%{scale:1;}38%{scale:.88;}70%{scale:1.06;}100%{scale:1;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="sorpresa"] .vp-mochi__mouth{animation:vp-mochi-macho-boca-sorpresa .7s cubic-bezier(.34,1.56,.64,1) both;}',
        '@keyframes vp-mochi-macho-boca-sorpresa{0%{scale:1 1;}38%{scale:1.14 1.48;}100%{scale:1.06 1.24;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="sorpresa"] .vp-mochi__bowtie{animation:vp-mochi-macho-corbata-sorpresa .7s cubic-bezier(.34,1.56,.64,1) both;transform-origin:50% 18%;}',
        '@keyframes vp-mochi-macho-corbata-sorpresa{0%{transform:translateX(-50%) rotate(0deg) translateY(0px) scale(1,1);}38%{transform:translateX(-50%) rotate(-9deg) translateY(-2.4px) scale(1.15,1.12);}70%{transform:translateX(-50%) rotate(4.5deg) translateY(0px) scale(1.04,1.02);}100%{transform:translateX(-50%) rotate(0deg) translateY(0px) scale(1,1);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="sorpresa"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-state="sorpresa"] .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-state="sorpresa"] .vp-mochi__ojos{animation:vp-mochi-macho-ojos-sorpresa .7s cubic-bezier(.34,1.56,.64,1) both;}',
        '@keyframes vp-mochi-macho-ojos-sorpresa{0%{scale:1 1;}30%{scale:1.14 1.35;}100%{scale:1.06 1.18;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="sorpresa"] .vp-mochi__pupil,.vp-mochi[data-profile=\"macho\"][data-state="sorpresa"] .vp-mochi__pupila{animation:vp-mochi-macho-mirar-sorpresa .7s cubic-bezier(.34,1.56,.64,1) both;}',
        '@keyframes vp-mochi-macho-mirar-sorpresa{0%{scale:1;}30%{scale:1.24;}100%{scale:1.12;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="sorpresa"] .vp-mochi__nariz,.vp-mochi[data-profile=\"macho\"][data-state="sorpresa"] .vp-mochi__nose{animation:vp-mochi-macho-nariz-sorpresa .7s cubic-bezier(.34,1.56,.64,1) both;}',
        '@keyframes vp-mochi-macho-nariz-sorpresa{0%{translate:0 0;}38%{translate:0 -.7px;}100%{translate:0 0;}}',

        // — bailando (infinite 1.1s) —
        '.vp-mochi[data-profile=\"macho\"][data-state="bailando"] .vp-mochi__body{animation:vp-mochi-macho-bailar 1.1s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-bailar{0%,100%{transform:translateY(0) rotate(0) scale(1,1);}25%{transform:translateY(-7px) rotate(9deg) scale(.96,1.06);}50%{transform:translateY(1.4px) rotate(0) scale(1.05,.95);}75%{transform:translateY(-2.5px) rotate(-9deg) scale(.97,1.04);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="bailando"] .vp-mochi__tail{animation:vp-mochi-macho-cola-bailar 1.1s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-cola-bailar{0%,50%,100%{transform:rotate(26deg) scale(1.07,.95);}25%,75%{transform:rotate(-16deg) scale(1,1);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="bailando"] .vp-mochi__ear{animation:vp-mochi-macho-oreja-bailar 1.1s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-oreja-bailar{0%,50%,100%{translate:0 0;rotate:calc(14deg * var(--oreja, 1));}25%,75%{translate:0 -2.4px;rotate:calc(-12deg * var(--oreja, 1));}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="bailando"] .vp-mochi__cheek{animation:vp-mochi-macho-mejilla-bailar 1.1s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-mejilla-bailar{0%,50%,100%{scale:1;}25%,75%{scale:1.15;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="bailando"] .vp-mochi__mouth{animation:vp-mochi-macho-boca-bailar 1.1s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-boca-bailar{0%,50%,100%{scale:1 1;}25%,75%{scale:1.12 1.25;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="bailando"] .vp-mochi__bowtie{animation:vp-mochi-macho-corbata-bailar 1.1s cubic-bezier(.45,.05,.35,.95) infinite;transform-origin:50% 18%;}',
        '@keyframes vp-mochi-macho-corbata-bailar{0%,100%{transform:translateX(-50%) rotate(0deg) translateY(0px);}25%{transform:translateX(-50%) rotate(-18deg) translateY(-1.8px);}75%{transform:translateX(-50%) rotate(18deg) translateY(-1.8px);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="bailando"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-state="bailando"] .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-state="bailando"] .vp-mochi__ojos{animation:vp-mochi-macho-ojos-bailar 1.1s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-ojos-bailar{0%,50%,100%{scale:1 .68;}25%,75%{scale:1 .52;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="bailando"] .vp-mochi__pupil,.vp-mochi[data-profile=\"macho\"][data-state="bailando"] .vp-mochi__pupila{animation:vp-mochi-macho-mirar-bailar 1.1s cubic-bezier(.7,0,.3,1) infinite;}',
        '@keyframes vp-mochi-macho-mirar-bailar{0%,100%{translate:0 0;}25%{translate:1.4px 0;}75%{translate:-1.4px 0;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="bailando"] .vp-mochi__nariz,.vp-mochi[data-profile=\"macho\"][data-state="bailando"] .vp-mochi__nose{animation:vp-mochi-macho-nariz-bailar 1.1s cubic-bezier(.45,.05,.35,.95) infinite;}',
        '@keyframes vp-mochi-macho-nariz-bailar{0%,50%,100%{translate:0 0;}25%{translate:0 -.6px;}75%{translate:0 .6px;}}',

        // — estornudo (one-shot .5s) —
        '.vp-mochi[data-profile=\"macho\"][data-state="estornudo"] .vp-mochi__body{animation:vp-mochi-macho-estornudo .5s cubic-bezier(.34,1.56,.64,1) both;}',
        '@keyframes vp-mochi-macho-estornudo{0%{transform:translateY(0) rotate(0) scale(1,1);}35%{transform:translateY(-2.5px) rotate(-1.5deg) scale(1.07,.94);}48%{transform:translateY(2.5px) rotate(2.5deg) scale(.9,1.16);}70%{transform:translateY(-1.2px) rotate(-.6deg) scale(1.04,.97);}100%{transform:translateY(0) rotate(0) scale(1,1);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="estornudo"] .vp-mochi__tail{animation:vp-mochi-macho-cola-estornudo .5s cubic-bezier(.34,1.56,.64,1) both;}',
        '@keyframes vp-mochi-macho-cola-estornudo{0%{transform:rotate(-12deg) scale(1,1);}35%{transform:rotate(-22deg) scale(.97,1);}48%{transform:rotate(22deg) scale(1.1,.92);}100%{transform:rotate(-8deg) scale(1,1);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="estornudo"] .vp-mochi__ear{animation:vp-mochi-macho-oreja-estornudo .5s cubic-bezier(.34,1.56,.64,1) both;}',
        '@keyframes vp-mochi-macho-oreja-estornudo{0%{translate:0 0;rotate:calc(0deg * var(--oreja, 1));}35%{translate:0 1.2px;rotate:calc(16deg * var(--oreja, 1));}48%{translate:0 -2.4px;rotate:calc(-12deg * var(--oreja, 1));}100%{translate:0 0;rotate:calc(0deg * var(--oreja, 1));}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="estornudo"] .vp-mochi__cheek{animation:vp-mochi-macho-mejilla-estornudo .5s cubic-bezier(.45,.05,.35,.95) both;}',
        '@keyframes vp-mochi-macho-mejilla-estornudo{0%{scale:1;}35%{scale:.92;}48%{scale:1.18;}100%{scale:1;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="estornudo"] .vp-mochi__mouth{animation:vp-mochi-macho-boca-estornudo .5s cubic-bezier(.34,1.56,.64,1) both;}',
        '@keyframes vp-mochi-macho-boca-estornudo{0%{scale:1 1;}35%{scale:.88 .68;}48%{scale:1.3 1.68;}100%{scale:1 1;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="estornudo"] .vp-mochi__bowtie{animation:vp-mochi-macho-corbata-estornudo .5s cubic-bezier(.34,1.56,.64,1) both;transform-origin:50% 18%;}',
        '@keyframes vp-mochi-macho-corbata-estornudo{0%{transform:translateX(-50%) rotate(0deg) translateY(0px);}35%{transform:translateX(-50%) rotate(-3.5deg) translateY(-1.2px);}48%{transform:translateX(-50%) rotate(10.5deg) translateY(2.4px);}100%{transform:translateX(-50%) rotate(0deg) translateY(0px);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="estornudo"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-state="estornudo"] .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-state="estornudo"] .vp-mochi__ojos{animation:vp-mochi-macho-ojos-estornudo .5s cubic-bezier(.45,.05,.35,.95) both;}',
        '@keyframes vp-mochi-macho-ojos-estornudo{0%{scale:1 1;}20%,55%{scale:1 .06;}72%{scale:1 .52;}100%{scale:1 1;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="estornudo"] .vp-mochi__pupil,.vp-mochi[data-profile=\"macho\"][data-state="estornudo"] .vp-mochi__pupila{animation:vp-mochi-macho-mirar-estornudo .5s cubic-bezier(.45,.05,.35,.95) both;}',
        '@keyframes vp-mochi-macho-mirar-estornudo{0%{scale:1;}35%{scale:.88;}48%{scale:1.15;}100%{scale:1;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="estornudo"] .vp-mochi__nariz,.vp-mochi[data-profile=\"macho\"][data-state="estornudo"] .vp-mochi__nose{animation:vp-mochi-macho-nariz-estornudo .5s cubic-bezier(.34,1.56,.64,1) both;}',
        '@keyframes vp-mochi-macho-nariz-estornudo{0%{translate:0 0;scale:1;}35%{translate:0 -.7px;scale:1.12;}48%{translate:0 1.4px;scale:1.18;}100%{translate:0 0;scale:1;}}',

        // — guiño (one-shot .35s) —
        '.vp-mochi[data-profile=\"macho\"][data-state="guiño"] .vp-mochi__body{animation:vp-mochi-macho-guino .35s cubic-bezier(.25,1,.5,1) both;}',
        '@keyframes vp-mochi-macho-guino{0%{transform:translateY(0) rotate(0) scale(1,1);}40%{transform:translateY(-1.2px) rotate(-3deg) scale(1.015,.985);}100%{transform:translateY(0) rotate(0) scale(1,1);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="guiño"] .vp-mochi__tail{animation:vp-mochi-macho-cola-guino .35s cubic-bezier(.34,1.56,.64,1) both;}',
        '@keyframes vp-mochi-macho-cola-guino{0%{transform:rotate(-8deg) scale(1,1);}45%{transform:rotate(16deg) scale(1.05,.97);}100%{transform:rotate(-6deg) scale(1,1);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="guiño"] .vp-mochi__ear{animation:vp-mochi-macho-oreja-guino .35s cubic-bezier(.34,1.56,.64,1) both;}',
        '@keyframes vp-mochi-macho-oreja-guino{0%{translate:0 0;rotate:calc(0deg * var(--oreja, 1));}40%{translate:0 -1.8px;rotate:calc(-7deg * var(--oreja, 1));}100%{translate:0 0;rotate:calc(0deg * var(--oreja, 1));}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="guiño"] .vp-mochi__cheek{animation:vp-mochi-macho-mejilla-guino .35s cubic-bezier(.25,1,.5,1) both;}',
        '@keyframes vp-mochi-macho-mejilla-guino{0%{scale:1;}40%{scale:1.1;}100%{scale:1;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="guiño"] .vp-mochi__mouth{animation:vp-mochi-macho-boca-guino .35s cubic-bezier(.25,1,.5,1) both;}',
        '@keyframes vp-mochi-macho-boca-guino{0%{scale:1 1;}40%{scale:1.08 .92;}100%{scale:1 1;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="guiño"] .vp-mochi__bowtie{animation:vp-mochi-macho-corbata-guino .35s cubic-bezier(.25,1,.5,1) both;transform-origin:50% 18%;}',
        '@keyframes vp-mochi-macho-corbata-guino{0%{transform:translateX(-50%) rotate(0deg) translateY(0px);}40%{transform:translateX(-50%) rotate(5deg) translateY(-.6px);}100%{transform:translateX(-50%) rotate(0deg) translateY(0px);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="guiño"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-state="guiño"] .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-state="guiño"] .vp-mochi__ojos{animation:vp-mochi-macho-ojos-guino-fijo .35s cubic-bezier(.25,1,.5,1) both;}',
        '@keyframes vp-mochi-macho-ojos-guino-fijo{0%,100%{scale:1 1;}40%{scale:1.03 1.06;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="guiño"] .vp-mochi__eye ~ .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-state="guiño"] .vp-mochi__ojo ~ .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-state="guiño"] .vp-mochi__ojos ~ .vp-mochi__ojos{animation:vp-mochi-macho-ojos-guino .35s cubic-bezier(.5,0,.5,1) both;}',
        '@keyframes vp-mochi-macho-ojos-guino{0%,18%{scale:1 1;}28%,68%{scale:1 .08;}85%,100%{scale:1 1;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="guiño"] .vp-mochi__pupil,.vp-mochi[data-profile=\"macho\"][data-state="guiño"] .vp-mochi__pupila{animation:vp-mochi-macho-mirar-guino .35s cubic-bezier(.7,0,.3,1) both;}',
        '@keyframes vp-mochi-macho-mirar-guino{0%{translate:0 0;}40%{translate:.7px 0;}100%{translate:0 0;}}',

        // ─── 14. RITMO ORGÁNICO EN IDLE ───
        // Cada detalle respira con un desfase pequeño para evitar un movimiento mecánico.
        '.vp-mochi[data-profile=\"macho\"][data-state="idle"] .vp-mochi__shine{animation-delay:-2.4s;} ',
        '.vp-mochi[data-profile=\"macho\"][data-state="idle"] .vp-mochi__tail{animation-delay:-.85s;} ',
        '.vp-mochi[data-profile=\"macho\"][data-state="idle"] .vp-mochi__ear--right{animation-delay:-2.45s;} ',
        '.vp-mochi[data-profile=\"macho\"][data-state="idle"] .vp-mochi__cheek--right{animation-delay:-2.35s;} ',
        '.vp-mochi[data-profile=\"macho\"][data-state="idle"] .vp-mochi__mouth{animation-delay:-1.2s;} ',
        '.vp-mochi[data-profile=\"macho\"][data-state="idle"] .vp-mochi__bowtie{animation-delay:-.6s;} ',
        '.vp-mochi[data-profile=\"macho\"][data-state="idle"] :is(.vp-mochi__eye--left,.vp-mochi__eye--right){animation-delay:0s;} ',

        // ─── 15. COREOGRAFÍA SUAVE Y DINÁMICA ───
        '.vp-mochi[data-profile=\"macho\"][data-state="idle"] .vp-mochi__body{animation:vp-mochi-macho-vivo-idle 3.6s cubic-bezier(.45,.05,.35,.95) infinite;} ',
        '@keyframes vp-mochi-macho-vivo-idle{0%,100%{transform:translateY(0) rotate(0deg) scale(1,1);}10%{transform:translateY(-1px) rotate(-.5deg) scale(1.012,.99);}22%{transform:translateY(-2.4px) rotate(-1deg) scale(1.025,.978);}34%{transform:translateY(-.4px) rotate(.4deg) scale(1.005,1.004);}48%{transform:translateY(-4.4px) rotate(-1.4deg) scale(.97,1.045);}56%{transform:translateY(.8px) rotate(.8deg) scale(1.03,.97);}64%{transform:translateY(-.8px) rotate(-.4deg) scale(1.01,.995);}76%{transform:translateY(-2.6px) rotate(1deg) scale(1.025,.98);}86%{transform:translateY(-4px) rotate(-1.2deg) scale(.98,1.035);}94%{transform:translateY(.4px) rotate(.3deg) scale(1.008,.995);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="idle"] .vp-mochi__tail{animation:vp-mochi-macho-vivo-cola 2.5s cubic-bezier(.45,.05,.35,.95) infinite;} ',
        '@keyframes vp-mochi-macho-vivo-cola{0%,100%{transform:rotate(-8deg) scale(1,1);}18%{transform:rotate(2deg) scale(1.02,.99);}34%{transform:rotate(15deg) scale(1.05,.96);}48%{transform:rotate(7deg) scale(1.02,.99);}64%{transform:rotate(-5deg) scale(1,1);}82%{transform:rotate(10deg) scale(1.04,.97);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="idle"] .vp-mochi__ear{animation:vp-mochi-macho-vivo-orejas 3.6s cubic-bezier(.45,.05,.35,.95) infinite;} ',
        '@keyframes vp-mochi-macho-vivo-orejas{0%,100%{translate:0 0;rotate:calc(0deg * var(--oreja, 1));}14%{translate:0 -.8px;rotate:calc(-5deg * var(--oreja, 1));}19%{translate:0 -2.2px;rotate:calc(-13deg * var(--oreja, 1));}25%{translate:0 -.5px;rotate:calc(2deg * var(--oreja, 1));}46%{translate:0 -1px;rotate:calc(6deg * var(--oreja, 1));}52%{translate:0 -2px;rotate:calc(11deg * var(--oreja, 1));}59%{translate:0 0;rotate:calc(-2deg * var(--oreja, 1));}78%{translate:0 -.6px;rotate:calc(4deg * var(--oreja, 1));}84%{translate:0 -1.6px;rotate:calc(-8deg * var(--oreja, 1));}90%{translate:0 0;rotate:calc(1deg * var(--oreja, 1));}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="hablando"] .vp-mochi__body{animation:vp-mochi-macho-vivo-hablar .62s cubic-bezier(.35,.05,.35,1) infinite;} ',
        '@keyframes vp-mochi-macho-vivo-hablar{0%,100%{transform:translateY(0) rotate(0) scale(1,1);}18%{transform:translateY(-1.2px) rotate(-.8deg) scale(1.02,.985);}38%{transform:translateY(-4px) rotate(-2deg) scale(1.04,.95);}55%{transform:translateY(-1px) rotate(1deg) scale(.99,1.02);}72%{transform:translateY(-2.4px) rotate(1.5deg) scale(.98,1.03);}88%{transform:translateY(-.6px) rotate(.2deg) scale(1.004,.997);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="hablando"] .vp-mochi__tail{animation:vp-mochi-macho-vivo-cola-hablar .72s cubic-bezier(.4,.1,.4,1) infinite;} ',
        '@keyframes vp-mochi-macho-vivo-cola-hablar{0%,100%{transform:rotate(-14deg) scale(1,1);}32%{transform:rotate(7deg) scale(1.03,.98);}58%{transform:rotate(25deg) scale(1.1,.94);}82%{transform:rotate(8deg) scale(1.02,.99);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="hablando"] .vp-mochi__ear{animation:vp-mochi-macho-vivo-orejas-hablar .78s cubic-bezier(.4,.1,.4,1) infinite;} ',
        '@keyframes vp-mochi-macho-vivo-orejas-hablar{0%,100%{translate:0 0;rotate:calc(-3deg * var(--oreja, 1));}34%{translate:0 -1.2px;rotate:calc(5deg * var(--oreja, 1));}62%{translate:0 -2px;rotate:calc(10deg * var(--oreja, 1));}84%{translate:0 -.5px;rotate:calc(1deg * var(--oreja, 1));}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="saludando"] .vp-mochi__body{animation:vp-mochi-macho-vivo-saludo 1.05s cubic-bezier(.34,1.2,.64,1) infinite;} ',
        '@keyframes vp-mochi-macho-vivo-saludo{0%,100%{transform:translateY(0) rotate(0) scale(1,1);}16%{transform:translateY(1.5px) rotate(-2.5deg) scale(1.03,.96);}36%{transform:translateY(-6px) rotate(10deg) scale(.96,1.06);}54%{transform:translateY(-1px) rotate(-3deg) scale(1.02,.98);}72%{transform:translateY(-5px) rotate(-8deg) scale(.97,1.05);}88%{transform:translateY(.5px) rotate(2deg) scale(1.01,.99);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="saludando"] .vp-mochi__tail{animation:vp-mochi-macho-vivo-cola-saludo .72s cubic-bezier(.34,1.2,.64,1) infinite;} ',
        '@keyframes vp-mochi-macho-vivo-cola-saludo{0%,100%{transform:rotate(-18deg) scale(1,1);}32%{transform:rotate(25deg) scale(1.08,.95);}58%{transform:rotate(-7deg) scale(1.02,.99);}82%{transform:rotate(17deg) scale(1.05,.96);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="pensando"] .vp-mochi__body{animation:vp-mochi-macho-vivo-pensar 2.8s cubic-bezier(.45,.05,.35,.95) infinite;} ',
        '@keyframes vp-mochi-macho-vivo-pensar{0%,100%{transform:translateY(0) rotate(0) scale(1,1);}24%{transform:translateY(-1px) rotate(-3deg) scale(1.015,.99);}47%{transform:translateY(-2.7px) rotate(-7deg) scale(1.03,.975);}68%{transform:translateY(-1px) rotate(-4deg) scale(1.015,.99);}84%{transform:translateY(.5px) rotate(4deg) scale(.99,1.01);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="pensando"] .vp-mochi__ear{animation:vp-mochi-macho-vivo-orejas-pensar 2.8s cubic-bezier(.45,.05,.35,.95) infinite;} ',
        '@keyframes vp-mochi-macho-vivo-orejas-pensar{0%,100%{translate:0 0;rotate:calc(-2deg * var(--oreja, 1));}42%{translate:0 -1px;rotate:calc(8deg * var(--oreja, 1));}58%{translate:0 -2.2px;rotate:calc(14deg * var(--oreja, 1));}78%{translate:0 -.5px;rotate:calc(-5deg * var(--oreja, 1));}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="enamorado"] .vp-mochi__body{animation:vp-mochi-macho-vivo-amor 1.6s cubic-bezier(.45,.05,.35,.95) infinite;} ',
        '@keyframes vp-mochi-macho-vivo-amor{0%,100%{transform:translateY(0) rotate(0) scale(1,1);}18%{transform:translateY(-3px) rotate(-1.5deg) scale(1.05,.95);}34%{transform:translateY(0) rotate(0) scale(1,1);}52%{transform:translateY(-7px) rotate(2deg) scale(1.08,.93);}68%{transform:translateY(-2px) rotate(0) scale(1.02,.99);}84%{transform:translateY(1px) rotate(-.5deg) scale(.99,1.02);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="enamorado"] .vp-mochi__tail{animation:vp-mochi-macho-vivo-cola-amor .78s cubic-bezier(.45,.05,.35,.95) infinite;} ',
        '@keyframes vp-mochi-macho-vivo-cola-amor{0%,100%{transform:rotate(-12deg) scale(1,1);}36%{transform:rotate(18deg) scale(1.06,.96);}68%{transform:rotate(3deg) scale(1.02,.99);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="pensando"] .vp-mochi__tail{animation:vp-mochi-macho-vivo-cola-espera 1.15s cubic-bezier(.34,1.2,.64,1) infinite;} ',
        '@keyframes vp-mochi-macho-vivo-cola-espera{0%,100%{transform:rotate(-14deg) scale(1,1);}28%{transform:rotate(13deg) scale(1.04,.97);}56%{transform:rotate(34deg) scale(1.1,.93);}78%{transform:rotate(-3deg) scale(1.02,.99);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="pensando"] .vp-mochi__bowtie{animation:vp-mochi-macho-vivo-mono-espera 2.8s cubic-bezier(.45,.05,.35,.95) infinite;transform-origin:50% 18%;} ',
        '@keyframes vp-mochi-macho-vivo-mono-espera{0%,100%{transform:translateX(-50%) rotate(-3deg) translateY(0);}42%{transform:translateX(-50%) rotate(5deg) translateY(-.8px);}62%{transform:translateX(-50%) rotate(9deg) translateY(-1px);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="curioso"] .vp-mochi__body{animation:vp-mochi-macho-vivo-curioso 1.8s cubic-bezier(.34,1.56,.64,1) infinite;} ',
        '@keyframes vp-mochi-macho-vivo-curioso{0%,100%{transform:translateY(0) rotate(0) scale(1,1);}18%{transform:translateY(1.5px) rotate(-2deg) scale(1.04,.96);}38%{transform:translateY(-5px) rotate(8deg) scale(.97,1.07);}56%{transform:translateY(-2.2px) rotate(3deg) scale(1.02,.985);}76%{transform:translateY(-4.4px) rotate(6deg) scale(.98,1.04);}90%{transform:translateY(-.8px) rotate(-1deg) scale(1.008,.995);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="curioso"] .vp-mochi__tail{animation:vp-mochi-macho-vivo-cola-curioso 1.3s cubic-bezier(.34,1.56,.64,1) infinite;} ',
        '@keyframes vp-mochi-macho-vivo-cola-curioso{0%,100%{transform:rotate(-12deg) scale(1,1);}35%{transform:rotate(18deg) scale(1.08,.94);}62%{transform:rotate(10deg) scale(1.03,.98);}82%{transform:rotate(-4deg) scale(1,1);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="curioso"] .vp-mochi__ear{animation:vp-mochi-macho-vivo-orejas-curioso 1.8s cubic-bezier(.34,1.56,.64,1) infinite;} ',
        '@keyframes vp-mochi-macho-vivo-orejas-curioso{0%,100%{translate:0 0;rotate:calc(-2deg * var(--oreja, 1));}28%{translate:0 -3px;rotate:calc(-12deg * var(--oreja, 1));}52%{translate:0 -1.5px;rotate:calc(4deg * var(--oreja, 1));}75%{translate:0 -2.8px;rotate:calc(7deg * var(--oreja, 1));}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="curioso"] .vp-mochi__bowtie{animation:vp-mochi-macho-vivo-mono-curioso 1.8s cubic-bezier(.34,1.56,.64,1) infinite;transform-origin:50% 18%;} ',
        '@keyframes vp-mochi-macho-vivo-mono-curioso{0%,100%{transform:translateX(-50%) rotate(-1deg) translateY(0);}34%{transform:translateX(-50%) rotate(8deg) translateY(-.8px);}58%{transform:translateX(-50%) rotate(12deg) translateY(-1.2px);}82%{transform:translateX(-50%) rotate(3deg) translateY(-.3px);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="curioso"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-state="curioso"] .vp-mochi__ojo,.vp-mochi[data-profile=\"macho\"][data-state="curioso"] .vp-mochi__ojos{animation:vp-mochi-macho-vivo-ojos-curioso 1.8s cubic-bezier(.34,1.56,.64,1) infinite;} ',
        '@keyframes vp-mochi-macho-vivo-ojos-curioso{0%,100%{scale:1 1;}20%{scale:1.05 1.1;}42%{scale:1.1 1.14;}72%{scale:1.04 1.08;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="curioso"] .vp-mochi__pupil,.vp-mochi[data-profile=\"macho\"][data-state="curioso"] .vp-mochi__pupila{animation:vp-mochi-macho-vivo-mirar-curioso 1.8s cubic-bezier(.7,0,.3,1) infinite;} ',
        '@keyframes vp-mochi-macho-vivo-mirar-curioso{0%,100%{translate:0 0;}22%{translate:2px -1.1px;}48%{translate:-1.4px 1px;}76%{translate:1.6px -.8px;}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="curioso"] .vp-mochi__shine{animation:vp-mochi-macho-vivo-shine-curioso 1.8s cubic-bezier(.34,1.56,.64,1) infinite;} ',
        '@keyframes vp-mochi-macho-vivo-shine-curioso{0%,100%{opacity:.8;transform:rotate(-30deg) scale(1,1);}42%{opacity:1;transform:rotate(-28deg) scale(1.2,1.12) translate(.8px,-.6px);}74%{opacity:.9;transform:rotate(-32deg) scale(1.06,.98);}}',

        '.vp-mochi[data-profile=\"macho\"][data-state="leyendo"] .vp-mochi__body{animation:vp-mochi-macho-vivo-leyendo 2.1s cubic-bezier(.45,.05,.35,.95) infinite;} ',
        '@keyframes vp-mochi-macho-vivo-leyendo{0%,100%{transform:translateY(0) rotate(0) scale(1,1);}26%{transform:translateY(-1.2px) rotate(-1.8deg) scale(1.015,.99);}52%{transform:translateY(-2.3px) rotate(1.8deg) scale(1.025,.98);}78%{transform:translateY(-.5px) rotate(-.8deg) scale(1.008,.996);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="leyendo"] .vp-mochi__tail{animation:vp-mochi-macho-vivo-cola-leyendo 2.1s cubic-bezier(.45,.05,.35,.95) infinite;} ',
        '@keyframes vp-mochi-macho-vivo-cola-leyendo{0%,100%{transform:rotate(5deg) scale(1,1);}38%{transform:rotate(15deg) scale(1.04,.97);}68%{transform:rotate(8deg) scale(1.02,.99);}}',
        '.vp-mochi[data-profile=\"macho\"][data-state="leyendo"] .vp-mochi__ear{animation:vp-mochi-macho-vivo-orejas-leyendo 2.1s cubic-bezier(.45,.05,.35,.95) infinite;} ',
        '@keyframes vp-mochi-macho-vivo-orejas-leyendo{0%,100%{translate:0 0;rotate:calc(-2deg * var(--oreja, 1));}32%{translate:0 -1px;rotate:calc(5deg * var(--oreja, 1));}58%{translate:0 -1.8px;rotate:calc(-4deg * var(--oreja, 1));}78%{translate:0 -.3px;rotate:calc(2deg * var(--oreja, 1));}}',

        // ─── 16. REDUCED MOTION (accesibilidad granular) ───
        '@media (prefers-reduced-motion:reduce){',
        '.vp-mochi[data-profile=\"macho\"]:is([data-state="idle"],[data-state="pensando"],[data-state="leyendo"],[data-state="hablando"],[data-state="saludando"],[data-state="somnoliento"],[data-state="durmiendo"],[data-state="despidiendo"],[data-state="enamorado"],[data-state="riendo"],[data-state="bailando"]) :is(.vp-mochi__body,.vp-mochi__tail,.vp-mochi__ear,.vp-mochi__cheek,.vp-mochi__mouth,.vp-mochi__bowtie,.vp-mochi__eye,.vp-mochi__ojo,.vp-mochi__ojos,.vp-mochi__pupil,.vp-mochi__pupila,.vp-mochi__nariz,.vp-mochi__nose,.vp-mochi__particle,.vp-mochi__shine){animation:none !important;}',
        '.vp-mochi[data-profile=\"macho\"]:not([data-state]) :is(.vp-mochi__body,.vp-mochi__tail,.vp-mochi__ear,.vp-mochi__cheek,.vp-mochi__mouth,.vp-mochi__bowtie,.vp-mochi__eye,.vp-mochi__ojo,.vp-mochi__ojos,.vp-mochi__pupil,.vp-mochi__pupila,.vp-mochi__nariz,.vp-mochi__nose,.vp-mochi__particle,.vp-mochi__shine){animation:none !important;}',

        '@keyframes vp-mochi-macho-rm-toque{0%,100%{scale:1;}50%{scale:1.03;}}',
        '.vp-mochi[data-profile=\"macho\"]:is([data-state="poke"],[data-state="curioso"],[data-state="estirando"],[data-state="acariciado"],[data-state="asustado"],[data-state="sorpresa"],[data-state="estornudo"],[data-state="guiño"]) :is(.vp-mochi__tail,.vp-mochi__ear,.vp-mochi__bowtie,.vp-mochi__shine){animation:none;}',
        '.vp-mochi[data-profile=\"macho\"][data-state="guiño"] .vp-mochi__body{animation:none;}',

        '.vp-mochi[data-profile=\"macho\"][data-state="poke"] .vp-mochi__body{animation:vp-mochi-macho-rm-toque .26s ease-out both;}',
        '.vp-mochi[data-profile=\"macho\"][data-state="poke"] :is(.vp-mochi__eye,.vp-mochi__ojo,.vp-mochi__ojos,.vp-mochi__cheek,.vp-mochi__mouth,.vp-mochi__pupil,.vp-mochi__pupila,.vp-mochi__nariz,.vp-mochi__nose){animation-duration:.26s;animation-timing-function:ease-out;}',

        '.vp-mochi[data-profile=\"macho\"][data-state="curioso"] .vp-mochi__body{animation:vp-mochi-macho-rm-toque .5s ease-out both;}',
        '.vp-mochi[data-profile=\"macho\"][data-state="curioso"] :is(.vp-mochi__eye,.vp-mochi__ojo,.vp-mochi__ojos,.vp-mochi__cheek,.vp-mochi__mouth,.vp-mochi__pupil,.vp-mochi__pupila,.vp-mochi__nariz,.vp-mochi__nose){animation-duration:.5s;animation-timing-function:ease-out;}',

        '.vp-mochi[data-profile=\"macho\"][data-state="estirando"] .vp-mochi__body{animation:vp-mochi-macho-rm-toque .6s ease-out both;}',
        '.vp-mochi[data-profile=\"macho\"][data-state="estirando"] :is(.vp-mochi__eye,.vp-mochi__ojo,.vp-mochi__ojos,.vp-mochi__cheek,.vp-mochi__mouth,.vp-mochi__pupil,.vp-mochi__pupila,.vp-mochi__nariz,.vp-mochi__nose){animation-duration:.6s;animation-timing-function:ease-out;}',

        '.vp-mochi[data-profile=\"macho\"][data-state="acariciado"] .vp-mochi__body{animation:vp-mochi-macho-rm-toque .45s ease-out both;}',
        '.vp-mochi[data-profile=\"macho\"][data-state="acariciado"] :is(.vp-mochi__eye,.vp-mochi__ojo,.vp-mochi__ojos,.vp-mochi__cheek,.vp-mochi__mouth,.vp-mochi__pupil,.vp-mochi__pupila,.vp-mochi__nariz,.vp-mochi__nose){animation-duration:.45s;animation-timing-function:ease-out;}',

        '.vp-mochi[data-profile=\"macho\"][data-state="asustado"] .vp-mochi__body{animation:vp-mochi-macho-rm-toque .3s ease-out both;}',
        '.vp-mochi[data-profile=\"macho\"][data-state="asustado"] :is(.vp-mochi__eye,.vp-mochi__ojo,.vp-mochi__ojos,.vp-mochi__cheek,.vp-mochi__mouth,.vp-mochi__pupil,.vp-mochi__pupila,.vp-mochi__nariz,.vp-mochi__nose){animation-duration:.3s;animation-timing-function:ease-out;}',

        '.vp-mochi[data-profile=\"macho\"][data-state="sorpresa"] .vp-mochi__body{animation:vp-mochi-macho-rm-toque .35s ease-out both;}',
        '.vp-mochi[data-profile=\"macho\"][data-state="sorpresa"] :is(.vp-mochi__eye,.vp-mochi__ojo,.vp-mochi__ojos,.vp-mochi__cheek,.vp-mochi__mouth,.vp-mochi__pupil,.vp-mochi__pupila,.vp-mochi__nariz,.vp-mochi__nose){animation-duration:.35s;animation-timing-function:ease-out;}',

        '.vp-mochi[data-profile=\"macho\"][data-state="estornudo"] .vp-mochi__body{animation:vp-mochi-macho-rm-toque .25s ease-out both;}',
        '.vp-mochi[data-profile=\"macho\"][data-state="estornudo"] :is(.vp-mochi__eye,.vp-mochi__ojo,.vp-mochi__ojos,.vp-mochi__cheek,.vp-mochi__mouth,.vp-mochi__pupil,.vp-mochi__pupila,.vp-mochi__nariz,.vp-mochi__nose){animation-duration:.25s;animation-timing-function:ease-out;}',

        '.vp-mochi[data-profile=\"macho\"][data-state="guiño"] :is(.vp-mochi__eye,.vp-mochi__ojo,.vp-mochi__ojos,.vp-mochi__cheek,.vp-mochi__mouth,.vp-mochi__pupil,.vp-mochi__pupila){animation-duration:.175s;animation-timing-function:ease-out;}',
        '.vp-mochi[data-profile=\"macho\"][data-state="guiño"] :is(.vp-mochi__eye,.vp-mochi__ojo,.vp-mochi__ojos) ~ :is(.vp-mochi__eye,.vp-mochi__ojo,.vp-mochi__ojos){animation-duration:.175s;animation-timing-function:ease-out;}',
        '}'
    ].join('');
    VP._mochiMacho.ANIMACIONES_MACHO = ANIMACIONES_MACHO;
})(window);

(function (window) {
    'use strict';
    var VP = window.VP;
    var ESTILOS_ESTADOS = [
        '.vp-mochi[data-profile=\"macho\"][data-ollama-status="waiting"] .vp-mochi__body{animation:vp-mochi-m-wait-body 1.35s cubic-bezier(.34,1.2,.64,1) infinite!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-ollama-status="waiting"] .vp-mochi__tail{animation:vp-mochi-m-wait-tail .68s cubic-bezier(.34,1.2,.64,1) infinite!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-ollama-status="waiting"] .vp-mochi__eye{animation:vp-mochi-m-wait-eyes 1.15s ease-in-out infinite!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-ollama-status="waiting"] .vp-mochi__ear--left{animation:vp-mochi-m-wait-ear-left 2.4s ease-in-out infinite alternate!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-ollama-status="waiting"] .vp-mochi__ear--right{animation:vp-mochi-m-wait-ear-right 2.4s ease-in-out infinite alternate!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-ollama-status="respuesta"] .vp-mochi__body{animation:vp-mochi-m-response-body 2s ease-in-out infinite!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-ollama-status="respuesta"] .vp-mochi__tail{animation:vp-mochi-m-response-tail 1.8s ease-in-out infinite!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-ollama-status="respuesta"] .vp-mochi__ear--left{animation:vp-mochi-m-response-ear-left 3.2s ease-in-out infinite alternate!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-ollama-status="respuesta"] .vp-mochi__ear--right{animation:vp-mochi-m-response-ear-right 3.7s ease-in-out infinite alternate!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-ollama-status="respuesta"] .vp-mochi__eye{animation:vp-mochi-m-response-eyes 1.5s ease-in-out infinite!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-ollama-status="respuesta"] .vp-mochi__eye--right{animation:vp-mochi-m-response-eyes 1.5s ease-in-out infinite,vp-mochi-m-response-wink 3s ease-in-out infinite!important;animation-delay:-.22s,0s!important;}',
        '@keyframes vp-mochi-m-wait-body{0%,100%{transform:translateY(0) rotate(0) scale(1)}20%{transform:translateY(1px) rotate(-2deg) scale(1.035,.96)}48%{transform:translateY(-5px) rotate(3deg) scale(.96,1.07)}74%{transform:translateY(-1px) rotate(-1deg) scale(1.02,.985)}}',
        '@keyframes vp-mochi-m-wait-tail{0%,100%{transform:rotate(-18deg)}34%{transform:rotate(12deg)}58%{transform:rotate(34deg)}82%{transform:rotate(-5deg)}}',
        '@keyframes vp-mochi-m-wait-eyes{0%,100%{transform:translate(-2px,1px)}24%{transform:translate(2px,-1px)}38%,44%{transform:translate(2px,-1px) scaleY(.18)}58%{transform:translate(-1px,0)}78%{transform:translate(-2px,-1px)}}',
        '@keyframes vp-mochi-m-wait-ear-left{0%,100%{transform:rotate(-18deg)}50%{transform:rotate(-22deg) translateY(-1px)}}',
        '@keyframes vp-mochi-m-wait-ear-right{0%,100%{transform:rotate(18deg)}50%{transform:rotate(14deg) translateY(-1px)}}',
        '@keyframes vp-mochi-m-response-body{0%,100%{transform:translateY(0) rotate(0) scale(1)}25%{transform:translateY(1px) rotate(-1.2deg) scale(1.025,.975)}56%{transform:translateY(-3px) rotate(1.2deg) scale(.985,1.025)}80%{transform:translateY(-.5px) scale(1.01,.995)}}',
        '@keyframes vp-mochi-m-response-tail{0%,100%{transform:rotate(-5deg)}50%{transform:rotate(7deg)}}',
        '@keyframes vp-mochi-m-response-eyes{0%,100%{transform:translate(0,0)}22%{transform:translate(-3px,-1px)}46%{transform:translate(3px,0)}70%{transform:translate(1px,1px)}88%{transform:translate(-2px,0)}}',
        '@keyframes vp-mochi-m-response-wink{0%,18%,40%,100%{scale:1 1}24%,36%{scale:1 .08}45%{scale:1 1}}',
        '@keyframes vp-mochi-m-response-ear-left{0%,100%{transform:rotate(-18deg)}24%{transform:rotate(-23deg) translateY(-1px)}55%{transform:rotate(-16deg)}78%{transform:rotate(-20deg)}}',
        '@keyframes vp-mochi-m-response-ear-right{0%,100%{transform:rotate(18deg)}24%{transform:rotate(14deg)}55%{transform:rotate(22deg)}78%{transform:rotate(16deg)}}',
        '.vp-mochi[data-profile=\"macho\"][data-tech-pose="CONTEXT_READY"] .vp-mochi__body{animation:vp-mochi-m-pose-ready .8s ease both!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-tech-pose="CONTEXT_READY"] .vp-mochi__ear{animation:vp-mochi-m-pose-ears .8s ease both!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-tech-pose="CONTEXT_READY"] .vp-mochi__eye{animation:vp-mochi-m-pose-eyes .8s ease both!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-tech-pose="REQUESTING_OLLAMA"] .vp-mochi__body{animation:vp-mochi-m-pose-send .6s ease both!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-tech-pose="REQUESTING_OLLAMA"] .vp-mochi__tail{animation:vp-mochi-m-pose-tail-up .6s ease both!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-tech-pose="PROCESSING_RESPONSE"] .vp-mochi__body{animation:vp-mochi-m-pose-think 2.6s ease both!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-tech-pose="PROCESSING_RESPONSE"] .vp-mochi__ear--right{animation:vp-mochi-m-pose-think-ear 2.6s ease both!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-tech-pose="PROCESSING_RESPONSE"] .vp-mochi__tail{animation:vp-mochi-m-pose-think-tail 2.6s ease both!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-tech-pose="PROCESSING_RESPONSE"] .vp-mochi__eye{transform:scaleY(.78)!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-tech-pose="WAITING_TIMING"] .vp-mochi__eye{animation:vp-mochi-m-pose-glance 2.8s ease both!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-tech-pose="WAITING_TIMING"] .vp-mochi__tail{animation:vp-mochi-m-pose-tail-wait 2.8s ease both!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-tech-pose="WAITING_TIMING"] .vp-mochi__ear{animation:vp-mochi-m-pose-listen 2.8s ease both!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-tech-pose="COOLDOWN"] .vp-mochi__body{animation:vp-mochi-m-pose-sleep 3s ease both!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-tech-pose="COOLDOWN"] .vp-mochi__eye{transform:scaleY(.12)!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-tech-pose="COOLDOWN"] .vp-mochi__ear{transform:rotate(12deg) translateY(1px)!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-tech-pose="COOLDOWN"] .vp-mochi__tail{transform:rotate(-35deg) scale(.82)!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-tech-pose="ERROR"] .vp-mochi__body{animation:vp-mochi-m-pose-error .8s ease both!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-tech-pose="ERROR"] .vp-mochi__ear{transform:rotate(-12deg) translateY(1px)!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-tech-pose="ERROR"] .vp-mochi__eye{transform:scale(1.12)!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-tech-detail="timeout"] .vp-mochi__tail{transform:none!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-tech-detail="empty"] .vp-mochi__body{transform:rotate(-2deg)!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-tech-detail="connection"] .vp-mochi__body,.vp-mochi[data-profile=\"macho\"][data-tech-detail="ollama-unavailable"] .vp-mochi__body{animation:vp-mochi-m-pose-connection .8s ease both!important;}',
        '.vp-mochi[data-profile=\"macho\"][data-tech-detail="ollama-unavailable"] .vp-mochi__eye--right{transform:scaleY(.76)!important;}',
        '@keyframes vp-mochi-m-pose-ready{0%,100%{transform:translateY(0)}25%{transform:translateY(-2px) scaleY(1.015)}}@keyframes vp-mochi-m-pose-ears{0%,100%{transform:translateY(0)}25%{transform:translateY(-1px) rotate(-3deg)}}@keyframes vp-mochi-m-pose-eyes{0%,100%{filter:none}25%{filter:brightness(1.18)}}',
        '@keyframes vp-mochi-m-pose-send{0%,100%{transform:translate(0,0)}25%,55%{transform:translate(1px,-1px) rotate(1deg)}}@keyframes vp-mochi-m-pose-tail-up{0%,100%{transform:translateY(0)}35%{transform:translateY(-2px) rotate(7deg)}}',
        '@keyframes vp-mochi-m-pose-think{0%,100%{transform:translate(0,0)}12%,75%{transform:translateY(1px) rotate(-1deg)}}@keyframes vp-mochi-m-pose-think-ear{0%,100%{transform:rotate(0)}14%,75%{transform:rotate(-5deg)}}@keyframes vp-mochi-m-pose-think-tail{0%,100%{transform:rotate(0)}50%{transform:rotate(-5deg)}}',
        '@keyframes vp-mochi-m-pose-glance{0%,100%{transform:translateX(0)}20%,40%{transform:translateX(-1px)}60%,80%{transform:translateX(1px)}}@keyframes vp-mochi-m-pose-tail-wait{0%,100%{transform:rotate(0)}30%,65%{transform:rotate(3deg)}}@keyframes vp-mochi-m-pose-listen{0%,100%{transform:rotate(0)}35%{transform:rotate(3deg)}70%{transform:rotate(-3deg)}}',
        '@keyframes vp-mochi-m-pose-sleep{0%,100%{transform:translateY(1px) scaleY(.99)}45%{transform:translateY(0) scaleY(1.015)}}@keyframes vp-mochi-m-pose-error{0%,100%{transform:translate(0,0)}22%,52%{transform:translateX(-1px)}38%,68%{transform:translateX(1px)}}@keyframes vp-mochi-m-pose-connection{0%,100%{transform:translate(0,0)}18%,48%{transform:translateX(-2px)}33%,63%{transform:translateX(2px)}}',
        '@media (prefers-reduced-motion:reduce){.vp-mochi[data-profile=\"macho\"][data-ollama-status="waiting"] .vp-mochi__body,.vp-mochi[data-profile=\"macho\"][data-ollama-status="waiting"] .vp-mochi__tail,.vp-mochi[data-profile=\"macho\"][data-ollama-status="waiting"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-ollama-status="waiting"] .vp-mochi__ear,.vp-mochi[data-profile=\"macho\"][data-ollama-status="respuesta"] .vp-mochi__body,.vp-mochi[data-profile=\"macho\"][data-ollama-status="respuesta"] .vp-mochi__tail,.vp-mochi[data-profile=\"macho\"][data-ollama-status="respuesta"] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-ollama-status="respuesta"] .vp-mochi__ear,.vp-mochi[data-profile=\"macho\"][data-tech-pose] .vp-mochi__body,.vp-mochi[data-profile=\"macho\"][data-tech-pose] .vp-mochi__tail,.vp-mochi[data-profile=\"macho\"][data-tech-pose] .vp-mochi__eye,.vp-mochi[data-profile=\"macho\"][data-tech-pose] .vp-mochi__ear{animation:none!important;}}',
        "\n.vp-mochi[data-profile=\"macho\"]:where(:not([data-mood=\"gracioso\"])):where(:not([data-mood=\"sarcastico\"])):where(:not([data-mood=\"tenso\"])):where(:not([data-mood=\"epico\"])):is([data-state=\"hablando\"],[data-state=\"leyendo\"])[data-talk-variant] .vp-mochi__profile-accessory{animation:vp-mochi-talk-accessory 1s ease-in-out infinite;}",
        "\n.vp-mochi[data-profile=\"macho\"][data-state=\"hablando\"][data-talk-variant=\"1\"] .vp-mochi__mouth{animation:vp-mochi-talk-mouth-1 .34s ease-in-out infinite;}.vp-mochi[data-profile=\"macho\"][data-state=\"hablando\"][data-talk-variant=\"2\"] .vp-mochi__mouth{animation:vp-mochi-talk-mouth-2 .5s ease-in-out infinite;}.vp-mochi[data-profile=\"macho\"][data-state=\"hablando\"][data-talk-variant=\"3\"] .vp-mochi__mouth{animation:vp-mochi-talk-mouth-3 .24s ease-in-out infinite;}.vp-mochi[data-profile=\"macho\"][data-state=\"hablando\"][data-talk-variant=\"4\"] .vp-mochi__mouth{animation:vp-mochi-talk-mouth-4 .42s ease-in-out infinite;}.vp-mochi[data-profile=\"macho\"][data-state=\"hablando\"][data-talk-variant=\"5\"] .vp-mochi__mouth{animation:vp-mochi-talk-mouth-5 .62s ease-in-out infinite;}",
        "\n@keyframes vp-mochi-talk-mouth-1{0%,100%{transform:translateX(-50%) scale(1,.72)}45%{transform:translateX(-50%) scale(1,.42)}70%{transform:translateX(-50%) scale(1,.62)}}@keyframes vp-mochi-talk-mouth-2{0%,100%{transform:translateX(-50%) scale(1,.7)}25%{transform:translateX(-50%) scale(1,.42)}48%{transform:translateX(-50%) scale(1,.66)}72%{transform:translateX(-50%) scale(1,.46)}}@keyframes vp-mochi-talk-mouth-3{0%,100%{transform:translateX(-50%) scale(1,.76)}38%{transform:translateX(-50%) scale(1,.4)}68%{transform:translateX(-50%) scale(1,.62)}}@keyframes vp-mochi-talk-mouth-4{0%,100%{transform:translateX(-50%) scale(1,.68)}32%{transform:translateX(-50%) scale(1,.43)}58%{transform:translateX(-50%) scale(1,.74)}82%{transform:translateX(-50%) scale(1,.46)}}@keyframes vp-mochi-talk-mouth-5{0%,100%{transform:translateX(-50%) scale(1,.72)}42%{transform:translateX(-50%) scale(1,.4)}66%{transform:translateX(-50%) scale(1,.62)}}",
        "\n@keyframes vp-mochi-talk-body-1{0%,100%{transform:translateY(0) scale(1)}35%{transform:translateY(-4px) scale(1.025,.98)}68%{transform:translateY(0) scale(.99,1.012)}}@keyframes vp-mochi-talk-body-2{0%,100%{transform:translateY(0) rotate(0)}24%{transform:translateY(-2px) rotate(-2.5deg)}55%{transform:translateY(-4px) rotate(2deg)}78%{transform:rotate(0)}}@keyframes vp-mochi-talk-body-3{0%,100%{transform:translateY(0) scale(1)}18%,52%{transform:translateY(-3px) scale(1.02,.99)}34%{transform:translateY(0)}}@keyframes vp-mochi-talk-body-4{0%,100%{transform:translateX(0) rotate(0)}30%{transform:translateX(-3px) rotate(-2deg)}62%{transform:translateX(3px) rotate(2deg)}}@keyframes vp-mochi-talk-body-5{0%,100%{transform:translateY(0) scale(1)}42%{transform:translateY(-5px) scale(1.03,.97)}72%{transform:translateY(-1px) scale(.99,1.01)}}",
        "\n@keyframes vp-mochi-talk-tail-1{0%,100%{transform:rotate(-8deg)}50%{transform:rotate(8deg)}}@keyframes vp-mochi-talk-tail-2{0%,100%{transform:rotate(-12deg)}35%{transform:rotate(5deg)}70%{transform:rotate(13deg)}}@keyframes vp-mochi-talk-tail-3{0%,100%{transform:rotate(0)}50%{transform:rotate(10deg)}}@keyframes vp-mochi-talk-tail-4{0%,100%{transform:rotate(5deg)}30%{transform:rotate(-8deg)}65%{transform:rotate(8deg)}}@keyframes vp-mochi-talk-tail-5{0%,100%{transform:rotate(-4deg)}42%{transform:rotate(12deg)}76%{transform:rotate(2deg)}}",
        "\n@keyframes vp-mochi-talk-ear-1{0%,100%{transform:rotate(0)}35%{transform:rotate(-3deg) translateY(-1px)}}@keyframes vp-mochi-talk-ear-2{0%,100%{transform:rotate(0)}28%{transform:rotate(4deg)}62%{transform:rotate(-2deg)}}@keyframes vp-mochi-talk-ear-3{0%,100%{transform:translateY(0)}45%{transform:translateY(-1.5px) rotate(-2deg)}}@keyframes vp-mochi-talk-ear-4{0%,100%{transform:rotate(0)}32%{transform:rotate(-4deg)}68%{transform:rotate(2deg)}}@keyframes vp-mochi-talk-ear-5{0%,100%{transform:translateY(0) rotate(0)}25%{transform:translateY(-1px) rotate(3deg)}58%{transform:rotate(-3deg)}}@keyframes vp-mochi-talk-accessory{0%,100%{translate:0 0}45%{translate:0 -1px}}",
        "\n@media (prefers-reduced-motion:reduce){.vp-mochi[data-profile=\"macho\"][data-state=\"hablando\"][data-talk-variant] .vp-mochi__body,.vp-mochi[data-profile=\"macho\"][data-state=\"hablando\"][data-talk-variant] .vp-mochi__tail,.vp-mochi[data-profile=\"macho\"][data-state=\"hablando\"][data-talk-variant] .vp-mochi__ear,.vp-mochi[data-profile=\"macho\"][data-state=\"hablando\"][data-talk-variant] .vp-mochi__mouth,.vp-mochi[data-profile=\"macho\"][data-state=\"hablando\"][data-talk-variant] .vp-mochi__profile-accessory{animation:none!important;}}",
  ].join('\n');

  for (var varianteHabla = 6; varianteHabla <= 35; varianteHabla++) {
    var pasoHabla = varianteHabla - 5;
    var duracionCuerpo = (0.38 + (pasoHabla % 8) * 0.07).toFixed(2);
    var duracionBoca = (0.23 + ((pasoHabla * 3) % 7) * 0.055).toFixed(3);
    var elevacion = (1.6 + ((pasoHabla * 3) % 8) * 0.45).toFixed(1);
    var inclinacion = ((pasoHabla * 7) % 13) - 6;
    var inclinacionAnticipacion = -inclinacion;
    var balanceo = ((pasoHabla * 5) % 9) - 4;
    var colaInicio = ((pasoHabla * 3) % 17) - 8;
    var colaArco = 10 + ((pasoHabla * 7) % 29);
    var orejaAngulo = 3 + ((pasoHabla * 5) % 13);
    var orejaElevacion = (0.5 + ((pasoHabla * 2) % 5) * 0.35).toFixed(1);
    var bocaAncho = '1';
    var bocaCerrada = (0.72 + ((pasoHabla * 3) % 4) * 0.05).toFixed(2);
    var bocaAbierta = (0.38 + ((pasoHabla * 5) % 5) * 0.06).toFixed(2);
    var bocaPico = 28 + ((pasoHabla * 11) % 29);
    var bocaCierre = 65 + ((pasoHabla * 7) % 24);
    var selectorHabla = '.vp-mochi[data-profile="macho"][data-state="hablando"][data-talk-variant="' + varianteHabla + '"]';
    var selectorMovimiento = '.vp-mochi[data-profile="macho"]:where(:not([data-mood="gracioso"])):where(:not([data-mood="sarcastico"])):where(:not([data-mood="tenso"])):where(:not([data-mood="epico"]))[data-state="hablando"][data-talk-variant="' + varianteHabla + '"]';
    var nombreAnimacion = 'vp-mochi-talk-extra-' + varianteHabla;

    ESTILOS_ESTADOS += [
      '\n' + selectorMovimiento + ' .vp-mochi__body{animation:' + nombreAnimacion + '-cuerpo ' + duracionCuerpo + 's cubic-bezier(.35,.05,.4,1) infinite;}',
      selectorMovimiento + ' .vp-mochi__tail{animation:' + nombreAnimacion + '-cola ' + (Number(duracionCuerpo) + 0.09).toFixed(2) + 's cubic-bezier(.4,.1,.4,1) infinite;}',
      selectorMovimiento + ' .vp-mochi__ear{animation:' + nombreAnimacion + '-orejas ' + (Number(duracionCuerpo) + 0.14).toFixed(2) + 's cubic-bezier(.4,.05,.4,1) infinite;}',
      selectorHabla + ' .vp-mochi__mouth{animation:' + nombreAnimacion + '-boca ' + duracionBoca + 's cubic-bezier(.4,.05,.4,1) infinite;}',
      '@keyframes ' + nombreAnimacion + '-cuerpo{0%,100%{transform:translateY(0) rotate(0) scale(1,1);}18%{transform:translateY(.5px) rotate(' + inclinacionAnticipacion + 'deg) scale(1.015,.99);}42%{transform:translate(' + balanceo + 'px,-' + elevacion + 'px) rotate(' + inclinacion + 'deg) scale(1.035,.96);}68%{transform:translateY(-1px) rotate(' + (inclinacion / -2).toFixed(1) + 'deg) scale(.99,1.015);}}',
      '@keyframes ' + nombreAnimacion + '-cola{0%,100%{transform:rotate(' + colaInicio + 'deg) scale(1,1);}34%{transform:rotate(' + colaArco + 'deg) scale(1.08,.95);}61%{transform:rotate(' + (-colaArco / 2).toFixed(1) + 'deg) scale(.98,1.02);}82%{transform:rotate(' + (colaInicio + 5) + 'deg) scale(1.02,.99);}}',
      '@keyframes ' + nombreAnimacion + '-orejas{0%,100%{transform:translateY(0) rotate(0);}32%{transform:translateY(-' + orejaElevacion + 'px) rotate(calc(' + orejaAngulo + 'deg * var(--oreja, 1)));}59%{transform:translateY(-' + (Number(orejaElevacion) * 1.5).toFixed(1) + 'px) rotate(calc(-' + (orejaAngulo / 2).toFixed(1) + 'deg * var(--oreja, 1)));}83%{transform:translateY(-.3px) rotate(calc(2deg * var(--oreja, 1)));}}',
      '@keyframes ' + nombreAnimacion + '-boca{0%,100%{transform:translateX(-50%) scale(' + bocaAncho + ',' + bocaCerrada + ');}'+ bocaPico + '%{transform:translateX(-50%) scale(' + bocaAncho + ',' + bocaAbierta + ');}'+ bocaCierre + '%{transform:translateX(-50%) scale(' + bocaAncho + ',' + (Number(bocaCerrada) - 0.08).toFixed(2) + ');}}'
    ].join('');
  }

  VP._mochiMacho.ESTILOS_ESTADOS = ESTILOS_ESTADOS;
})(window);
