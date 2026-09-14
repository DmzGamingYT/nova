/* ============================================================
   Orbe Nova — canvas réutilisable (toutes les pages du site)
   États : prête → écoute → réflexion → parole (clic pour cycler)
   API : NovaOrb.init(canvas, stateEl) → { set(state) }
   ============================================================ */
window.NovaOrb = (function(){
  const PALETTES = {
    ready:  { hi:'#b3a7ff', mid:'#7c6cff', lo:'#33249e', glow:'124,108,255', label:'prête' },
    listen: { hi:'#9defd8', mid:'#2fbf9b', lo:'#177a63', glow:'47,191,155',  label:'elle écoute' },
    think:  { hi:'#b3a7ff', mid:'#7c6cff', lo:'#33249e', glow:'124,108,255', label:'elle réfléchit' },
    speak:  { hi:'#ffd9a0', mid:'#f5a83c', lo:'#b06a12', glow:'245,168,60',  label:'elle parle' },
  };

  function init(canvas, stateEl){
    const ctx = canvas.getContext('2d');
    const S = canvas.width, C = S/2;
    let state = 'ready', t = 0, wavePhase = 0;

    function setState(s){
      state = s;
      if (stateEl){
        stateEl.textContent = PALETTES[s].label;
        stateEl.style.color = 'rgb('+PALETTES[s].glow+')';
        stateEl.style.borderColor = 'rgba('+PALETTES[s].glow+',.5)';
      }
    }

    function orbRadius(ang){
      const breathe = state==='ready' ? 6 : state==='listen' ? 12 : state==='think' ? 7 : 16;
      return 250
        + Math.sin(ang*3 + t*.021) * breathe
        + Math.sin(ang*5 - t*.017) * breathe*.6
        + Math.sin(ang*2 + t*.011) * breathe*.8;
    }

    function drawOrb(){
      const p = PALETTES[state];
      const g0 = ctx.createRadialGradient(C,C,40,C,C,390);
      g0.addColorStop(0,'rgba('+p.glow+',.32)');
      g0.addColorStop(1,'rgba('+p.glow+',0)');
      ctx.fillStyle = g0; ctx.fillRect(0,0,S,S);

      const gx = C-70, gy = C-90;
      const g1 = ctx.createRadialGradient(gx,gy,20,C,C,255);
      g1.addColorStop(0,p.hi); g1.addColorStop(.4,p.mid); g1.addColorStop(1,p.lo);
      ctx.fillStyle = g1;
      ctx.beginPath();
      for (let a=0;a<=Math.PI*2+.02;a+=.02){
        const r = orbRadius(a);
        const x = C+Math.cos(a)*r, y = C+Math.sin(a)*r;
        a===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
      }
      ctx.closePath(); ctx.fill();

      const g2 = ctx.createRadialGradient(gx,gy,4,gx,gy,90);
      g2.addColorStop(0,'rgba(255,255,255,.85)'); g2.addColorStop(1,'rgba(255,255,255,0)');
      ctx.fillStyle = g2;
      ctx.beginPath(); ctx.ellipse(gx,gy,62,42,-.4,0,Math.PI*2); ctx.fill();
    }

    function drawOrbits(){
      const p = PALETTES[state];
      ctx.strokeStyle = 'rgba('+p.glow+',.25)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(C,C,330,0,Math.PI*2); ctx.stroke();
      ctx.strokeStyle = 'rgba('+p.glow+',.1)';
      ctx.beginPath(); ctx.arc(C,C,280,0,Math.PI*2); ctx.stroke();
      for (let k=0;k<2;k++){
        const sp = k===0 ? .004 : -.0028;
        const R = k===0 ? 330 : 280;
        const xs = C+Math.cos(t*sp + k*2.4)*R, ys = C+Math.sin(t*sp + k*2.4)*R;
        ctx.fillStyle = k===0 ? 'rgba('+p.glow+',.95)' : 'rgba(179,167,255,.8)';
        ctx.beginPath(); ctx.arc(xs,ys, k===0?9:6, 0,Math.PI*2); ctx.fill();
      }
    }

    function drawListenWaves(){
      for (let i=0;i<2;i++){
        const ph = (wavePhase*.35 + i*.5) % 1;
        const r = 255 + ph*150;
        ctx.strokeStyle = 'rgba(47,191,155,'+(0.5*(1-ph))+')';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(C,C,r,0,Math.PI*2); ctx.stroke();
      }
    }

    function drawEqualizer(){
      const bars = 9, bw = 12, gap = 10;
      const total = bars*bw + (bars-1)*gap;
      const x0 = C - total/2;
      for (let i=0;i<bars;i++){
        const h = 26 + Math.abs(Math.sin(t*.11 + i*1.1))*72 * (1 - Math.abs(i-(bars-1)/2)/(bars));
        const x = x0 + i*(bw+gap);
        const y = C - h/2 + 320;
        ctx.fillStyle = 'rgba(245,168,60,.9)';
        ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x,y,bw,h,6) : ctx.rect(x,y,bw,h); ctx.fill();
      }
    }

    function frame(){
      t++;
      if (state==='listen') wavePhase += .012;
      ctx.clearRect(0,0,S,S);
      drawOrbits();
      if (state==='listen') drawListenWaves();
      drawOrb();
      if (state==='speak') drawEqualizer();
      requestAnimationFrame(frame);
    }
    frame();

    canvas.addEventListener('click', () => {
      setState(state==='ready' ? 'listen' : state==='listen' ? 'think' : state==='think' ? 'speak' : 'ready');
    });

    return { set: setState };
  }

  return { init };
})();
