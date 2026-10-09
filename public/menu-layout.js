const STORAGE_KEY = 'babb:menu-columns:v1';
const COLUMN_OPTIONS = ['1', '2', '3'];
let activeCleanup;

export function initMenuLayout() {
  activeCleanup?.();

  const buttons = [...document.querySelectorAll('.view-switcher [data-columns]')]
    .filter((button) => COLUMN_OPTIONS.includes(button.dataset.columns));
  const mobile = window.matchMedia('(max-width: 900px)');
  let preferredColumns = '2';
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (COLUMN_OPTIONS.includes(saved)) preferredColumns = saved;
  } catch { /* Keep the default if storage is unavailable. */ }

  function render() {
    const columns = mobile.matches ? '1' : preferredColumns;
    document.documentElement.dataset.columns = columns;
    for (const button of buttons) {
      button.setAttribute('aria-pressed', String(button.dataset.columns === columns));
    }
  }

  function selectColumns(event) {
    if (mobile.matches) return;
    preferredColumns = event.currentTarget.dataset.columns;
    try { localStorage.setItem(STORAGE_KEY, preferredColumns); } catch { /* The current view still changes. */ }
    render();
  }

  for (const button of buttons) button.addEventListener('click', selectColumns);
  if (mobile.addEventListener) mobile.addEventListener('change', render);
  else mobile.addListener(render);
  render();

  const cleanup = () => {
    for (const button of buttons) button.removeEventListener('click', selectColumns);
    if (mobile.removeEventListener) mobile.removeEventListener('change', render);
    else mobile.removeListener(render);
    if (activeCleanup === cleanup) activeCleanup = undefined;
  };
  activeCleanup = cleanup;
  return cleanup;
}
