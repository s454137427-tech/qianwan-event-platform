'use strict';
(() => {
  const canvas = document.getElementById('ambientCanvas');
  if (!canvas) return;
  const context = canvas.getContext('2d');
  if (!context) return;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let width = 0,
    height = 0,
    particles = [],
    frame = 0,
    lastFrame = 0;
  function resize() {
    width = innerWidth;
    height = innerHeight;
    const scale = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    const count = width < 700 ? 28 : 52;
    particles = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      radius: Math.random() * 1.2 + 0.35,
      speed: Math.random() * 0.14 + 0.025,
      phase: Math.random() * Math.PI * 2
    }));
    draw(0);
  }
  function draw(time) {
    context.clearRect(0, 0, width, height);
    for (let i = 0; i < particles.length; i++) {
      const particle = particles[i];
      if (!reducedMotion.matches) {
        particle.y -= particle.speed;
        if (particle.y < -4) particle.y = height + 4;
      }
      const alpha = reducedMotion.matches
        ? 0.45
        : 0.25 + (Math.sin(time * 0.0005 + particle.phase) + 1) * 0.18;
      context.fillStyle = `rgba(104,198,255,${alpha})`;
      context.beginPath();
      context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
      context.fill();
      if (width >= 700)
        for (let j = i + 1; j < particles.length; j++) {
          const other = particles[j],
            distance = Math.hypot(particle.x - other.x, particle.y - other.y);
          if (distance < 110) {
            context.strokeStyle = `rgba(125,143,255,${(1 - distance / 110) * 0.08})`;
            context.lineWidth = 0.6;
            context.beginPath();
            context.moveTo(particle.x, particle.y);
            context.lineTo(other.x, other.y);
            context.stroke();
          }
        }
    }
  }
  function animate(time) {
    frame = 0;
    if (document.hidden || canvas.hidden || reducedMotion.matches) return;
    if (time - lastFrame >= 40) {
      draw(time);
      lastFrame = time;
    }
    frame = requestAnimationFrame(animate);
  }
  function resume() {
    canvas.hidden = !['', '#home'].includes(location.hash);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (!document.hidden && !canvas.hidden && !reducedMotion.matches)
      frame = requestAnimationFrame(animate);
    else draw(0);
  }
  addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', resume);
  addEventListener('hashchange', resume);
  reducedMotion.addEventListener('change', resume);
  resize();
  resume();
})();
