// Applies the saved theme on secondary pages (legal, admin).
try {
  const s = JSON.parse(localStorage.getItem('dunia.settings') || '{}');
  const mode = s.theme || 'system';
  const light = mode === 'light' || (mode === 'system' && matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
} catch { /* keep default */ }
