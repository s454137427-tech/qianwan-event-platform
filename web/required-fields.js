'use strict';
(() => {
  function marker() {
    const span = document.createElement('span');
    span.className = 'required-mark';
    span.textContent = '*';
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
  for (const id of ['applicationForm', 'workForm']) {
    const form = document.getElementById(id);
    const note = document.createElement('p');
    note.id = `${id}RequiredNote`;
    note.className = 'required-note';
    note.append(marker(), ' 为必填项');
    form.querySelector('.panel-heading').after(note);
    form.setAttribute('aria-describedby', note.id);
  }
  const fields = [
    '#applicationForm [name="realName"]',
    '#applicationForm [name="phone"]',
    '#applicationForm [name="idType"]',
    '#applicationForm [name="idNumber"]',
    '#identityFile',
    '#workForm [name="title"]',
    '#workForm [name="author"]'
  ];
  for (const selector of fields) {
    const field = document.querySelector(selector);
    field.before(marker());
    field.setAttribute('aria-required', 'true');
  }
  const consent = document.querySelector('#applicationForm [name="consent"]');
  consent.closest('label').querySelector('span').prepend(marker());
  consent.setAttribute('aria-required', 'true');

  const video = document.getElementById('videoFile');
  const videoMark = marker();
  video.before(videoMark);
  video.setAttribute('aria-required', 'true');
})();
