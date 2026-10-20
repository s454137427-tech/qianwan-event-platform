'use strict';
(() => {
  const guide = document.getElementById('contestRules');
  if (!guide) return;
  const buttons = [...guide.querySelectorAll('[data-guide-target]')];
  const chapters = buttons.map((button) => document.getElementById(button.dataset.guideTarget));
  const activate = (id) => {
    for (const button of buttons) {
      if (button.dataset.guideTarget === id) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
    }
  };
  for (const button of buttons) {
    button.addEventListener('click', () => {
      const chapter = document.getElementById(button.dataset.guideTarget);
      if (!chapter) return;
      activate(chapter.id);
      chapter.scrollIntoView({
        block: 'start',
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
      });
      chapter.focus({ preventScroll: true });
    });
  }
  // Use section positions so fast scrolling past several headings cannot leave a stale highlight.
  let frame = 0;
  const update = () => {
    frame = 0;
    if (!guide.getClientRects().length) return;
    const boundary =
      innerWidth <= 860
        ? guide.querySelector('.guide-sidebar').getBoundingClientRect().bottom + 20
        : 110;
    const current =
      chapters
        .filter(Boolean)
        .reverse()
        .find((chapter) => chapter.getBoundingClientRect().top <= boundary) || chapters[0];
    if (current) activate(current.id);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule, { passive: true });
  addEventListener('hashchange', schedule);
  schedule();
})();
