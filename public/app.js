const input = document.querySelector('#photo');
const status = document.querySelector('#status');
const preview = document.querySelector('#preview');
const download = document.querySelector('#download');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readJson(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('El servidor devolvió una respuesta inesperada.');
  }
  if (!response.ok) throw new Error(body.error || 'La petición falló.');
  return body;
}

async function upload(photo) {
  input.disabled = true;
  preview.hidden = true;
  preview.removeAttribute('src');
  download.hidden = true;
  status.textContent = 'Subiendo foto…';

  try {
    const form = new FormData();
    form.append('photo', photo);
    const created = await readJson(await fetch('/api/jobs', { method: 'POST', body: form }));
    status.textContent = 'Generando modelo… puede tardar 1-3 minutos.';

    while (true) {
      const job = await readJson(await fetch(`/api/jobs/${encodeURIComponent(created.id)}`, { cache: 'no-store' }));
      if (job.status === 'ready') {
        preview.src = job.modelUrl;
        preview.hidden = false;
        download.href = job.modelUrl;
        download.hidden = false;
        status.textContent = '¡Modelo listo! Arrastra para girarlo.';
        return;
      }
      if (job.status === 'error') throw new Error(job.error || 'La generación del modelo falló.');
      await pause(2000);
    }
  } catch (error) {
    status.textContent = `Error: ${error.message}`;
  } finally {
    input.disabled = false;
    input.value = '';
  }
}

input.addEventListener('change', () => {
  const photo = input.files?.[0];
  if (photo) void upload(photo);
});
