/**
 * Firestore `menus/current` 문서를 실시간 구독해 메뉴 이미지를 표시합니다.
 * 필드:
 * - restaurants: [{ id, name, imageUrl }] (신규)
 * - imageUrl: string (구버전 호환)
 * - date (선택)
 * - updatedAt (선택: Firestore Timestamp)
 * - restaurants/{rid}: emojiCounts(누적 투표), sacrificedEmojiCounts(흡수+패배 희생 누적), emojiCrownMerge
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  onSnapshot,
  query,
  orderBy,
  limit,
  serverTimestamp,
  setDoc,
  increment,
  updateDoc,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyCpQ-Q0fEyjRIpXUQ2VrntpVuiUbhVkak8',
  authDomain: 'babb-6cbaf.firebaseapp.com',
  projectId: 'babb-6cbaf',
  storageBucket: 'babb-6cbaf.firebasestorage.app',
  messagingSenderId: '565390681272',
  appId: '1:565390681272:web:7a65ee4670e0bcb4ce404d',
  measurementId: 'G-9G3XJBN4YL',
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');
const updatedLine = document.getElementById('updated-line');
const menusEl = document.getElementById('menus');
const debugEl = document.getElementById('debug');
const DEBUG_ENABLED = new URLSearchParams(window.location.search).has('debug');
const ghFooter = document.getElementById('gh-footer');
if (ghFooter) ghFooter.hidden = !DEBUG_ENABLED;

let lastRenderedRestaurants = [];

function ensureImageModal() {
  let root = document.getElementById('image-modal');
  if (root) {
    const panel = root.querySelector('.image-modal-panel');
    const img = root.querySelector('img');
    const closeBtn = root.querySelector('button.image-modal-close');
    return { root, panel, img, closeBtn };
  }

  root = document.createElement('div');
  root.id = 'image-modal';
  root.className = 'image-modal';

  const panel = document.createElement('div');
  panel.className = 'image-modal-panel';
  const img = document.createElement('img');
  img.alt = '메뉴 이미지 크게 보기';
  img.decoding = 'async';
  img.loading = 'lazy';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'image-modal-close';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', '닫기');

  panel.appendChild(img);
  panel.appendChild(closeBtn);
  root.appendChild(panel);
  document.body.appendChild(root);

  const isPc =
    window.matchMedia &&
    window.matchMedia('(pointer: fine)').matches &&
    !window.matchMedia('(max-width: 900px)').matches;
  let blockCloseUntil = 0;
  const touchCloseBlock = () => {
    blockCloseUntil = Date.now() + 1000;
  };

  const fitPanelToImage = () => {
    if (!isPc) return;
    const nw = Number(img.naturalWidth) || 0;
    const nh = Number(img.naturalHeight) || 0;
    if (nw <= 0 || nh <= 0) return;
    const aspect = nw / nh;
    const gutter = 24; // panel padding(12px*2)
    const maxW = Math.max(0, Math.floor(window.innerWidth * 0.96) - gutter);
    const maxH = Math.max(0, Math.floor(window.innerHeight * 0.92) - gutter);
    const minW = 520;
    const minH = 420;

    let w = maxW;
    let h = Math.round(w / aspect);
    if (h > maxH) {
      h = maxH;
      w = Math.round(h * aspect);
    }
    if (w < minW) {
      w = minW;
      h = Math.round(w / aspect);
    }
    if (h < minH) {
      h = minH;
      w = Math.round(h * aspect);
    }
    // 최종적으로 화면 범위 내로
    if (w > maxW) {
      w = maxW;
      h = Math.round(w / aspect);
    }
    if (h > maxH) {
      h = maxH;
      w = Math.round(h * aspect);
    }

    panel.style.width = `${w + gutter}px`;
    panel.style.height = `${h + gutter}px`;
  };

  if (isPc) {
    const dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    for (const d of dirs) {
      const h = document.createElement('div');
      h.className = `modal-resize-handle ${d}`;
      h.dataset.dir = d;
      panel.appendChild(h);
    }

    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

    const startResize = (ev, dir) => {
      ev.preventDefault();
      ev.stopPropagation();
      touchCloseBlock();

      const rect = panel.getBoundingClientRect();
      const startW = rect.width;
      const startH = rect.height;
      const aspect = startW / startH || 1;
      const startX = ev.clientX;
      const startY = ev.clientY;

      const sx = dir.includes('e') ? 1 : dir.includes('w') ? -1 : 0;
      const sy = dir.includes('s') ? 1 : dir.includes('n') ? -1 : 0;

      const vwMax = Math.floor(window.innerWidth * 0.96);
      const vhMax = Math.floor(window.innerHeight * 0.92);
      const gutter = 24; // panel padding(12px*2)
      const minW = 520;
      const minH = 420;
      const vwMaxInner = Math.max(0, vwMax - gutter);
      const vhMaxInner = Math.max(0, vhMax - gutter);

      let moved = false;
      const onMove = (e) => {
        moved = true;
        touchCloseBlock();
        const dx = (e.clientX - startX) * sx;
        const dy = (e.clientY - startY) * sy;

        let nextW = startW;
        let nextH = startH;
        if (dir === 'n' || dir === 's') {
          nextH = Math.round(startH + dy);
          nextH = Math.max(minH + gutter, Math.min(vhMax, nextH));
        } else {
          const scaleX = sx !== 0 ? (startW + dx) / startW : 1;
          const scaleY = sy !== 0 ? (startH + dy) / startH : 1;
          let scale = Math.max(scaleX, scaleY);
          scale = clamp(scale, 0.85, 1.9);
          nextW = Math.round(startW * scale);
          nextH = Math.round(nextW / aspect);

          if (nextW < minW + gutter) {
            nextW = minW + gutter;
            nextH = Math.round(nextW / aspect);
          }
          if (nextH < minH + gutter) {
            nextH = minH + gutter;
            nextW = Math.round(nextH * aspect);
          }
          if (nextW > vwMax) {
            nextW = vwMax;
            nextH = Math.round(nextW / aspect);
          }
          if (nextH > vhMax) {
            nextH = vhMax;
            nextW = Math.round(nextH * aspect);
          }
        }

        panel.style.width = `${nextW}px`;
        panel.style.height = `${nextH}px`;
      };
      const onUp = () => {
        touchCloseBlock();
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        if (moved) touchCloseBlock();
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    };

    panel.addEventListener(
      'pointerdown',
      (ev) => {
        const t = ev.target;
        if (!(t instanceof HTMLElement)) return;
        if (!t.classList.contains('modal-resize-handle')) return;
        const dir = t.dataset.dir || '';
        if (!dir) return;
        startResize(ev, dir);
      },
      true,
    );

    panel.addEventListener(
      'dblclick',
      (ev) => {
        const t = ev.target;
        if (!(t instanceof HTMLElement)) return;
        if (!t.classList.contains('modal-resize-handle')) return;
        const dir = t.dataset.dir || '';
        if (dir !== 'ne' && dir !== 'nw' && dir !== 'se' && dir !== 'sw') return;
        ev.preventDefault();
        ev.stopPropagation();
        touchCloseBlock();
        fitPanelToImage();
      },
      true,
    );

    root.addEventListener(
      'click',
      () => {
        if (Date.now() < blockCloseUntil) return;
        root.classList.remove('on');
        img.removeAttribute('src');
      },
      true,
    );
  }

  const close = () => {
    root.classList.remove('on');
    img.removeAttribute('src');
  };
  closeBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    close();
  });
  if (!isPc) root.addEventListener('click', () => close());
  panel.addEventListener('click', (ev) => ev.stopPropagation());
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') close();
  });

  img.addEventListener('load', () => {
    // 새 이미지 로드시 기본 '딱 맞춤'으로 잡아줌(아래 잘림 방지)
    fitPanelToImage();
  });

  return { root, panel, img, closeBtn };
}

function openImageModal(src, altText) {
  const m = ensureImageModal();
  m.img.alt = altText || '메뉴 이미지 크게 보기';
  m.img.src = src;
  m.root.classList.add('on');
}

function ensureCompareModal() {
  let root = document.getElementById('compare-modal');
  if (root) {
    const grid = root.querySelector('.compare-grid');
    const panel = root.querySelector('.compare-modal-panel');
    const closeBtn = root.querySelector('button.image-modal-close');
    return { root, panel, grid, closeBtn };
  }

  root = document.createElement('div');
  root.id = 'compare-modal';
  root.className = 'image-modal';

  const panel = document.createElement('div');
  panel.className = 'image-modal-panel compare-modal-panel';

  const grid = document.createElement('div');
  grid.className = 'compare-grid';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'image-modal-close';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', '닫기');

  panel.appendChild(grid);
  panel.appendChild(closeBtn);
  root.appendChild(panel);
  document.body.appendChild(root);

  // 테두리/코너 리사이즈 핸들(PC 전용). 크기는 "대각선(비율 유지)"으로만 조정.
  const isPc =
    window.matchMedia &&
    window.matchMedia('(pointer: fine)').matches &&
    !window.matchMedia('(max-width: 900px)').matches;
  let blockCloseUntil = 0;
  const touchCloseBlock = () => {
    blockCloseUntil = Date.now() + 1000;
  };
  if (isPc) {
    const dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    for (const d of dirs) {
      const h = document.createElement('div');
      h.className = `modal-resize-handle ${d}`;
      h.dataset.dir = d;
      panel.appendChild(h);
    }

    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

    const startResize = (ev, dir) => {
      ev.preventDefault();
      ev.stopPropagation();
      touchCloseBlock();

      const rect = panel.getBoundingClientRect();
      const startW = rect.width;
      const startH = rect.height;
      const aspect = startW / startH || 1;
      const startX = ev.clientX;
      const startY = ev.clientY;

      const sx = dir.includes('e') ? 1 : dir.includes('w') ? -1 : 0;
      const sy = dir.includes('s') ? 1 : dir.includes('n') ? -1 : 0;

      let moved = false;
      const onMove = (e) => {
        moved = true;
        touchCloseBlock();
        const dx = (e.clientX - startX) * sx;
        const dy = (e.clientY - startY) * sy;
        const vwMax = Math.floor(window.innerWidth * 0.96);
        const vhMax = Math.floor(window.innerHeight * 0.92);
        const minW = 920;
        const minH = 520;

        // 상/하는 "세로만" 조정. 나머지(좌/우/코너)는 "대각선(비율 유지)".
        let nextW = startW;
        let nextH = startH;
        if (dir === 'n' || dir === 's') {
          nextH = Math.round(startH + dy);
          nextH = Math.max(minH, Math.min(vhMax, nextH));
        } else {
          // "대각선 크기만" 바뀌게: 가로/세로 중 더 크게 요구되는 스케일을 채택
          const scaleX = sx !== 0 ? (startW + dx) / startW : 1;
          const scaleY = sy !== 0 ? (startH + dy) / startH : 1;
          let scale = Math.max(scaleX, scaleY);
          scale = clamp(scale, 0.85, 1.75);

          nextW = Math.round(startW * scale);
          nextH = Math.round(nextW / aspect);

          // 상한/하한 + 비율 유지 보정
          if (nextW < minW) {
            nextW = minW;
            nextH = Math.round(nextW / aspect);
          }
          if (nextH < minH) {
            nextH = minH;
            nextW = Math.round(nextH * aspect);
          }
          if (nextW > vwMax) {
            nextW = vwMax;
            nextH = Math.round(nextW / aspect);
          }
          if (nextH > vhMax) {
            nextH = vhMax;
            nextW = Math.round(nextH * aspect);
          }
        }

        panel.style.width = `${nextW}px`;
        panel.style.height = `${nextH}px`;
      };
      const onUp = (e) => {
        touchCloseBlock();
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        if (moved) {
          // 리사이즈 직후 1초는 바깥 클릭으로 닫히지 않게
          touchCloseBlock();
        }
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    };

    panel.addEventListener(
      'pointerdown',
      (ev) => {
        const t = ev.target;
        if (!(t instanceof HTMLElement)) return;
        if (!t.classList.contains('modal-resize-handle')) return;
        const dir = t.dataset.dir || '';
        if (!dir) return;
        startResize(ev, dir);
      },
      true,
    );

    // 패널 클릭(리사이즈 포함) 후 1초간은 외부 클릭으로 닫힘 방지
    panel.addEventListener('pointerdown', () => touchCloseBlock(), true);
    root.addEventListener(
      'click',
      () => {
        if (Date.now() < blockCloseUntil) return;
        root.classList.remove('on');
      },
      true,
    );
  }

  const close = () => root.classList.remove('on');
  closeBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    close();
  });
  if (!isPc) {
    root.addEventListener('click', () => close());
  }
  panel.addEventListener('click', (ev) => ev.stopPropagation());
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') close();
  });

  return { root, panel, grid, closeBtn };
}

function openCompareModal(restaurants) {
  const m = ensureCompareModal();
  const list = Array.isArray(restaurants) ? restaurants : [];
  const order = ['beoksan', 'theeats', 'bombom'];
  const byId = new Map(list.map((r) => [r.id, r]));
  const sorted = order.map((id) => byId.get(id)).filter(Boolean);
  let finalList = (sorted.length > 0 ? sorted : list).filter(
    (r) => r && typeof r.imageUrl === 'string' && r.imageUrl.length > 0,
  );

  const isPc =
    window.matchMedia &&
    window.matchMedia('(pointer: fine)').matches &&
    !window.matchMedia('(max-width: 900px)').matches;

  const setCols = () => {
    const n = finalList.length;
    m.grid.classList.remove('cols-1', 'cols-2', 'cols-3');
    m.grid.classList.add(n <= 1 ? 'cols-1' : n === 2 ? 'cols-2' : 'cols-3');
  };

  const fitPanelToCount = () => {
    if (!isPc || !m.panel) return;
    const n = finalList.length;
    const vwMax = Math.floor(window.innerWidth * 0.96);
    const vhMax = Math.floor(window.innerHeight * 0.92);
    const minW = n <= 1 ? 720 : n === 2 ? 980 : 1400;
    const minH = 520;
    const w = Math.min(vwMax, minW);
    const h = Math.min(vhMax, Math.max(minH, 620));
    m.panel.style.width = `${w}px`;
    m.panel.style.height = `${h}px`;
  };

  const render = () => {
    m.grid.innerHTML = '';
    setCols();
    for (let idx = 0; idx < finalList.length; idx += 1) {
      const r = finalList[idx];
      const item = document.createElement('div');
      item.className = 'compare-item';
      item.dataset.id = String(r.id || idx);
      const cap = document.createElement('div');
      cap.className = 'cap';
      cap.textContent = r.name || r.id || '메뉴';
      const img = document.createElement('img');
      img.alt = `${cap.textContent} 메뉴`;
      img.decoding = 'async';
      img.loading = 'lazy';
      img.src = r.imageUrl;
      item.appendChild(cap);
      item.appendChild(img);
      m.grid.appendChild(item);
    }
  };

  render();

  // PC에서만 드래그 재정렬/제외 제공
  if (isPc) {
    let draggingId = null;
    let placeholder = null;
    let ghost = null;

    const getItemElFromTarget = (t) => {
      if (!(t instanceof HTMLElement)) return null;
      return t.closest('.compare-item');
    };

    const ensurePlaceholder = () => {
      if (placeholder && placeholder.parentNode) return placeholder;
      placeholder = document.createElement('div');
      placeholder.className = 'compare-placeholder';
      return placeholder;
    };

    const indexById = (id) => finalList.findIndex((r) => String(r.id) === String(id));

    const moveItem = (from, to) => {
      if (from === to || from < 0 || to < 0) return;
      const next = finalList.slice();
      const [it] = next.splice(from, 1);
      next.splice(to, 0, it);
      finalList = next;
    };

    const removeItem = (idx) => {
      if (idx < 0 || idx >= finalList.length) return;
      finalList = finalList.filter((_, i) => i !== idx);
    };

    const createGhostFromItem = (itemEl) => {
      const g = document.createElement('div');
      g.className = 'compare-drag-ghost';
      // 복제본으로 고스트를 만들면 "왼쪽 위에서 가져오는" 점프가 줄고 DOM 재배치도 없음
      const clone = itemEl.cloneNode(true);
      if (clone instanceof HTMLElement) clone.classList.remove('dragging');
      g.appendChild(clone);
      document.body.appendChild(g);
      return g;
    };

    const cleanupDrag = () => {
      draggingId = null;
      for (const el of m.grid.querySelectorAll('.compare-item.dragging')) {
        el.classList.remove('dragging');
      }
      if (placeholder && placeholder.parentNode) placeholder.remove();
      if (ghost && ghost.parentNode) ghost.remove();
      ghost = null;
    };

    const movePlaceholderToPointer = (clientX, clientY) => {
      if (!placeholder || !placeholder.parentNode) return;
      const ph = placeholder;
      const children = [...m.grid.children].filter((el) => el !== ph);
      if (children.length === 0) {
        m.grid.appendChild(ph);
        return;
      }

      // 포인터 기준으로 "가장 가까운" 아이템을 찾고, 그 아이템의 앞/뒤로 placeholder를 이동
      // - 1열(세로)일 땐 y 기준
      // - 2~3열일 땐 같은 행(row) 판단 후 x 기준(행이 다르면 y 우선)
      const rects = children
        .map((el) => ({ el, rect: el.getBoundingClientRect() }))
        .filter((x) => x.rect.width > 0 && x.rect.height > 0);
      if (rects.length === 0) {
        m.grid.appendChild(ph);
        return;
      }

      const vw = window.innerWidth || 0;
      const isSingleCol = vw <= 900; // CSS에서 모바일은 1열 고정
      let best = rects[0];
      let bestScore = Number.POSITIVE_INFINITY;
      for (const r of rects) {
        const cx = r.rect.left + r.rect.width / 2;
        const cy = r.rect.top + r.rect.height / 2;
        const dx = clientX - cx;
        const dy = clientY - cy;
        const score = dx * dx + dy * dy;
        if (score < bestScore) {
          bestScore = score;
          best = r;
        }
      }

      const targetRect = best.rect;
      const midX = targetRect.left + targetRect.width / 2;
      const midY = targetRect.top + targetRect.height / 2;
      const before = isSingleCol ? clientY < midY : clientX < midX;

      if (before) best.el.before(ph);
      else best.el.after(ph);
    };

    const onPointerDown = (ev) => {
      const item = getItemElFromTarget(ev.target);
      if (!item) return;
      // 캡션/이미지 아무데나 잡아도 드래그 가능
      draggingId = item.dataset.id || null;
      if (!draggingId) return;
      ev.preventDefault();
      ev.stopPropagation();
      const ph = ensurePlaceholder();
      const startX = ev.clientX;
      const startY = ev.clientY;
      item.classList.add('dragging');

      // placeholder가 "원래 자리"를 대체해야 자연스럽습니다.
      // item을 그대로 두고 placeholder를 추가로 넣으면 칸이 하나 더 생겨 보입니다.
      item.replaceWith(ph);
      // 클릭 직후에도 "포인터 기준 변경 구역"이 바로 보이게
      movePlaceholderToPointer(startX, startY);

      ghost = createGhostFromItem(item);
      ghost.classList.add('picked');
      // 최초 프레임: transition 없이 커서 위치로 "즉시" 배치 → 왼쪽 위에서 오는 모션 방지
      const offsetX = 18;
      const offsetY = 18;
      ghost.style.transition = 'none';
      ghost.style.transform = `translate3d(${startX + offsetX}px,${startY + offsetY}px,0) scale(1)`;
      ghost.style.opacity = '0';
      // 다음 프레임부터 transition 활성화
      window.requestAnimationFrame(() => {
        if (!ghost) return;
        ghost.classList.add('ready');
      });

      const onMove = (e) => {
        // 모달에서 멀어질수록 축소/페이드(밖으로 뺄 때 사라지는 느낌)
        const panelRect = m.panel ? m.panel.getBoundingClientRect() : null;
        let dist = 0;
        if (panelRect) {
          const cx = Math.max(panelRect.left, Math.min(e.clientX, panelRect.right));
          const cy = Math.max(panelRect.top, Math.min(e.clientY, panelRect.bottom));
          dist = Math.hypot(e.clientX - cx, e.clientY - cy);
        }
        const s = Math.max(0.15, Math.min(1, 1 - dist / 520));
        const op = Math.max(0.05, Math.min(1, 1 - dist / 320));
        if (ghost) {
          ghost.style.opacity = String(op);
          ghost.style.transform = `translate3d(${e.clientX + offsetX}px,${e.clientY + offsetY}px,0) scale(${s})`;
        }
        const over = document.elementFromPoint(e.clientX, e.clientY);
        const overGrid = over instanceof HTMLElement ? over.closest('.compare-grid') : null;
        if (overGrid) {
          // 포인터 좌표로 placeholder 위치를 계산(항상 커서 기준으로 "변경 구역"이 따라오게)
          movePlaceholderToPointer(e.clientX, e.clientY);
        }
      };

      const onUp = (e) => {
        const over = document.elementFromPoint(e.clientX, e.clientY);
        const overGrid = over instanceof HTMLElement ? over.closest('.compare-grid') : null;
        const phIndex =
          placeholder && placeholder.parentNode ? [...m.grid.children].indexOf(placeholder) : -1;
        const fromIdx = indexById(draggingId);

        if (!overGrid) {
          // 밖으로 드랍: 제거
          if (fromIdx >= 0) removeItem(fromIdx);
        } else if (phIndex >= 0 && fromIdx >= 0) {
          // 재정렬
          moveItem(fromIdx, phIndex);
        }

        item.classList.remove('dragging');
        cleanupDrag();
        render();
        // 자동 축소는 제거. 대신 코너 더블클릭으로 '딱 맞춤' 제공
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
      };

      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    };

    // 중복 바인딩 방지: 이전 핸들러가 있으면 제거
    if (m.grid._compareDragBound) {
      m.grid.removeEventListener('pointerdown', m.grid._compareDragBound, true);
    }
    m.grid._compareDragBound = onPointerDown;
    m.grid.addEventListener('pointerdown', onPointerDown, true);

    // 코너(리사이즈 핸들) 더블클릭 시 현재 개수에 맞게 패널 크기 추천값으로 맞춤
    if (m.panel && !m.panel._compareFitBound) {
      const onDbl = (ev) => {
        const t = ev.target;
        if (!(t instanceof HTMLElement)) return;
        if (!t.classList.contains('modal-resize-handle')) return;
        const dir = t.dataset.dir || '';
        if (dir !== 'ne' && dir !== 'nw' && dir !== 'se' && dir !== 'sw') return;
        ev.preventDefault();
        ev.stopPropagation();
        fitPanelToCount();
      };
      m.panel._compareFitBound = onDbl;
      m.panel.addEventListener('dblclick', onDbl, true);
    }
  }

  m.root.classList.add('on');
}

const EMOJIS = ['😍', '😋', '🤔', '😑', '😒', '😡', '🤬'];
/** 단마쿠 가로 이동 속도(px/s). 짧은 글·긴 글 모두 같은 속도로 우→좌 전체 횡단 */
const DANMAKU_PX_PER_SEC_MIN = 48;
const DANMAKU_PX_PER_SEC_MAX = 68;
/** 이모지 종류당 튕기는 공 최대 개수(투표 폭주 시 부하 제한) */
const PINBALL_MAX_PER_EMOJI = 5;
/** 왕관 이모지가 같은 종류를 흡수해 커지는 단계 상한(흡수 5회 = 최대 크기, 이후 동일 종류 추가 흡수 없음) */
const CROWN_ABSORB_CAP = 5;
/** rAF 한 프레임당 대략 이동량(px). 값이 클수록 빠름 */
const PINBALL_SPEED_MIN = 1.1;
const PINBALL_SPEED_MAX = 2.4;
/** 이모지 클릭 콤보 리셋 간격(ms) */
const VOTE_COMBO_RESET_MS = 1300;
/** 최종 연출 단계: 무지개 + ? 전용 */
const VOTE_COMBO_RAINBOW_STAGE = 100;
/**
 * 투표 이펙트 위치/강도 튜닝
 * 아래 숫자만 바꾸면 위치를 손쉽게 미세 조정할 수 있습니다.
 */
const VOTE_FX_TUNE = {
  // 분수(+1) 시작점 오프셋 (마우스 좌표 기준)
  originOffsetX: -5,
  originOffsetY: -20,
  // 콤보 스탬프 기본 위치(분수 기준 오른쪽 위)
  comboOffsetX: 20,
  comboOffsetY: -20,
  // 콤보 스탬프의 차곡차곡 쌓이는 간격
  comboLaneGapY: 14,
  // 콤보 위치 랜덤 흔들림(너무 크면 가독성 저하)
  comboJitterX: 10,
  comboJitterY: 6,
  // 150+ WARNING 순찰 효과 위치/이동 튜닝
  // - anchorMix: +1 시작점(0) ~ 콤보 시작점(1) 사이 보간
  warningAnchorMixX: 0.5,
  warningAnchorMixY: 0.5,
  // 보간 후 추가 오프셋
  warningOffsetX: 0,
  warningOffsetY: 0,
  // 오른쪽 -> 왼쪽 이동 거리
  warningTravelX: 180,
  // 워닝 이동 범위 스케일(0.5 = 기존의 50%)
  warningTravelScale: 0.5,
  // WARNING 연출 속도/주기
  warningCooldownMs: 900,
  warningDurationMs: 1900,
  // 레이어 끝에서 잘리지 않도록 안전 패딩
  edgePadding: 18,
};
/**
 * 파괴(충돌 패배) 연출 문구 설정.
 * - at: 이 수치 이상부터 해당 구간 멘트 사용
 * - tagline: 하단 멘트 (원하는 문구로 직접 수정)
 * - accent: 강조색(선택)
 */
const DESTROY_STREAK_ALERTS = [
  {
    at: 10,
    tagline: 'Rampage!',
    accent: 'rgba(255, 92, 92, 0.88)',
  },
  {
    at: 30,
    tagline: 'No Mercy!!',
    accent: 'rgba(255, 108, 70, 0.9)',
  },
  {
    at: 50,
    tagline: 'Bloodbath!!!',
    accent: 'rgba(255, 130, 72, 0.9)',
  },
  {
    at: 100,
    tagline: 'Massacre!!!!',
    accent: 'rgba(255, 156, 72, 0.92)',
  },
  {
    at: 300,
    tagline: 'Extermination!!!!!',
    accent: 'rgba(255, 184, 84, 0.94)',
  },
  {
    at: 500,
    tagline: 'Why? We dying?',
    accent: 'rgba(255, 214, 122, 0.95)',
  },
  {
    at: 1000,
    tagline: 'Endless War...',
    accent: 'rgba(255, 178, 66, 0.92)',
  },
];
/**
 * [3분리 연출 튜닝]
 * 1) GRAVE(🪦X): 콤보 동안 고정
 * 2) NUMBER(숫자): 콤보마다 갱신
 * 3) MESSAGE(구간 문구): 구간 진입 시 1회 노출
 *
 * 각 파트별 글로우를 독립적으로 조절할 수 있습니다.
 */
const DESTROY_HUD_STYLE_TUNE = {
  graveGlow:
    '0 0 26px rgba(0,0,0,1), 0 0 50px rgba(0,0,0,1), 0 0 94px rgba(0,0,0,1), 0 0 162px rgba(0,0,0,0.98), 0 0 252px rgba(0,0,0,0.95)',
  numberGlow:
    '0 0 30px rgba(0,0,0,1), 0 0 58px rgba(0,0,0,1), 0 0 108px rgba(0,0,0,1), 0 0 186px rgba(0,0,0,0.98), 0 0 286px rgba(0,0,0,0.95)',
  messageGlow:
    '0 0 18px rgba(0,0,0,1), 0 0 34px rgba(0,0,0,1), 0 0 62px rgba(0,0,0,0.98), 0 0 108px rgba(0,0,0,0.96), 0 0 168px rgba(0,0,0,0.92)',
  messageStroke: '1.7px rgba(0, 0, 0, 0.95)',
};
/**
 * 구간 메시지(3번)의 타격감/지속시간 튜닝.
 * - showMs: 일반 구간 메시지 노출 시간(전체)
 * - stage500ShowMs: 500~999 구간 메시지 노출 시간
 * - calmShowMs: 1000+ 구간 노출 시간(무타격)
 * - impactDurationMs: 타격 애니메이션 시간
 */
const DESTROY_MESSAGE_FX_TUNE = {
  showMs: 2800,
  stage500ShowMs: 10000,
  calmShowMs: 30000,
  impactDurationMs: 4300,
};

function todayDateKorea() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// 남구로역(대략) 좌표
const WEATHER_LAT = 37.4868;
const WEATHER_LON = 126.8876;

function weatherIconFromCode(code) {
  // Open-Meteo weathercode
  if (code === 0) return '☀️';
  if (code === 1 || code === 2) return '🌤️';
  if (code === 3) return '☁️';
  if (code === 45 || code === 48) return '🌫️';
  if ([51, 53, 55, 56, 57].includes(code)) return '🌦️';
  if ([61, 63, 65, 66, 67].includes(code)) return '🌧️';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return '🌨️';
  if ([80, 81, 82].includes(code)) return '🌧️';
  if ([95, 96, 99].includes(code)) return '⛈️';
  return '🌡️';
}

function formatKstMonthDayTime(d) {
  const kst = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const m = String(kst.getMonth() + 1);
  const day = String(kst.getDate());
  const hh = String(kst.getHours()).padStart(2, '0');
  const mm = String(kst.getMinutes()).padStart(2, '0');
  return `${m}월 ${day}일 ${hh}:${mm}`;
}

async function updateWeatherNowHourly() {
  const iconEl = document.getElementById('weather-icon');
  const tempEl = document.getElementById('weather-temp');
  const timeEl = document.getElementById('weather-time');
  if (!iconEl || !tempEl || !timeEl) return;

  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}` +
      `&longitude=${WEATHER_LON}` +
      `&hourly=temperature_2m,weathercode` +
      `&timezone=Asia%2FSeoul`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`weather http ${res.status}`);
    const data = await res.json();

    const now = new Date();
    const nowKst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const hourKey = `${nowKst.getFullYear()}-${String(nowKst.getMonth() + 1).padStart(2, '0')}-${String(nowKst.getDate()).padStart(2, '0')}T${String(nowKst.getHours()).padStart(2, '0')}:00`;

    const times = data?.hourly?.time || [];
    const idx = times.indexOf(hourKey);
    const t = idx >= 0 ? data.hourly.temperature_2m[idx] : null;
    const c = idx >= 0 ? data.hourly.weathercode[idx] : null;

    if (typeof t === 'number') tempEl.textContent = `${Math.round(t)}°C`;
    if (typeof c === 'number') iconEl.textContent = weatherIconFromCode(c);
    timeEl.textContent = formatKstMonthDayTime(now);
  } catch (e) {
    // 조용히 실패(메뉴 기능은 계속)
    console.error(e);
  }
}

function scheduleWeatherHourly() {
  const now = new Date();
  const nowKst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const next = new Date(nowKst);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  const ms = Math.max(1000, next.getTime() - nowKst.getTime());
  setTimeout(() => {
    updateWeatherNowHourly();
    scheduleWeatherHourly();
  }, ms);
}

updateWeatherNowHourly();
scheduleWeatherHourly();

function randomColor() {
  const palette = [
    '#FF4D6D',
    '#FFD166',
    '#06D6A0',
    '#4D96FF',
    '#B517FF',
    '#F72585',
    '#72EFDD',
  ];
  return palette[Math.floor(Math.random() * palette.length)];
}

function formatFirestoreTime(value) {
  if (!value) return '';
  if (typeof value.toDate === 'function') {
    try {
      return value.toDate().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    } catch {
      return '';
    }
  }
  return '';
}

function showError(message) {
  loadingEl.hidden = true;
  errorEl.hidden = false;
  errorEl.textContent = message;
  updatedLine.hidden = true;
  menusEl.innerHTML = '';
  if (debugEl) debugEl.hidden = true;
}

function showDebug(data, renderedRestaurants) {
  if (!DEBUG_ENABLED) return;
  if (!debugEl) return;
  const debug = {
    restaurants_len: Array.isArray(data.restaurants) ? data.restaurants.length : null,
    rendered_len: renderedRestaurants.length,
    restaurants: renderedRestaurants.map((r) => ({
      id: r.id ?? null,
      name: r.name ?? null,
      imageUrl: r.imageUrl ?? null,
    })),
    legacy_imageUrl:
      typeof data.imageUrl === 'string' && data.imageUrl.length > 0 ? data.imageUrl : null,
    captureErrors: Array.isArray(data.captureErrors) ? data.captureErrors : null,
  };
  debugEl.textContent = JSON.stringify(debug, null, 2);
  debugEl.hidden = false;
}

function renderMenus(restaurants) {
  const cleanups = window.__BABB_PINBALL_CLEANUPS__;
  if (Array.isArray(cleanups)) {
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  }
  window.__BABB_PINBALL_CLEANUPS__ = [];

  menusEl.innerHTML = '';
  for (const r of restaurants) {
    const card = document.createElement('section');
    card.className = 'menu-card';

    const title = document.createElement('div');
    title.className = 'menu-title';

    const titleTop = document.createElement('div');
    titleTop.className = 'menu-title-top';
    const titleName = document.createElement('span');
    titleName.className = 'menu-title-name';
    titleName.textContent = r.name || r.id || '메뉴';
    titleTop.appendChild(titleName);

    const titleMid = document.createElement('div');
    titleMid.className = 'menu-title-mid';
    const titleGrave = document.createElement('span');
    titleGrave.className = 'grave-icon';
    titleGrave.textContent = '🪦';
    titleMid.appendChild(titleGrave);

    const titleBottom = document.createElement('div');
    titleBottom.className = 'menu-title-bottom';
    const titleRight = document.createElement('span');
    titleRight.className = 'title-right';
    titleBottom.appendChild(titleRight);

    title.appendChild(titleTop);
    title.appendChild(titleMid);
    title.appendChild(titleBottom);

    const wrap = document.createElement('div');
    wrap.className = 'img-wrap';

    const pinballLayer = document.createElement('div');
    pinballLayer.className = 'emoji-pinball';
    pinballLayer.setAttribute('aria-hidden', 'true');

    const danmaku = document.createElement('div');
    danmaku.className = 'danmaku';
    const voteBurstLayer = document.createElement('div');
    voteBurstLayer.className = 'vote-burst-layer';
    voteBurstLayer.setAttribute('aria-hidden', 'true');
    const destroyStreakLayer = document.createElement('div');
    destroyStreakLayer.className = 'destroy-streak-layer';
    destroyStreakLayer.setAttribute('aria-hidden', 'true');
    const destroyHud = document.createElement('div');
    destroyHud.className = 'destroy-streak-hud';
    destroyHud.hidden = true;
    const destroyHudLine = document.createElement('div');
    destroyHudLine.className = 'destroy-streak-line';
    const destroyHudGrave = document.createElement('span');
    destroyHudGrave.className = 'destroy-streak-grave';
    destroyHudGrave.textContent = '🪦X';
    const destroyHudNumber = document.createElement('span');
    destroyHudNumber.className = 'destroy-streak-number';
    destroyHudNumber.textContent = '0';
    const destroyMessageFx = document.createElement('div');
    destroyMessageFx.className = 'destroy-streak-message-fx';
    destroyMessageFx.hidden = true;
    destroyHudLine.appendChild(destroyHudGrave);
    destroyHudLine.appendChild(destroyHudNumber);
    destroyHud.appendChild(destroyHudLine);
    destroyStreakLayer.appendChild(destroyHud);
    destroyStreakLayer.appendChild(destroyMessageFx);

    const img = document.createElement('img');
    img.alt = `${titleName.textContent} 메뉴`;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = r.imageUrl;
    img.draggable = false;
    img.addEventListener('dragstart', (ev) => ev.preventDefault());

    const actions = document.createElement('div');
    actions.className = 'menu-actions';
    actions.hidden = true;

    const viewOnlyBtn = document.createElement('button');
    viewOnlyBtn.type = 'button';
    viewOnlyBtn.className = 'menu-viewonly-btn';
    viewOnlyBtn.textContent = '메뉴만 보기';
    viewOnlyBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openImageModal(img.src, img.alt);
    });
    actions.appendChild(viewOnlyBtn);

    const catchupBadge = document.createElement('div');
    catchupBadge.className = 'catchup-badge';
    catchupBadge.textContent = '동기화중입니다.. 제발 정상적으로 투표를 진행해주세요..';
    wrap.appendChild(catchupBadge);

    const emojiRow = document.createElement('div');
    emojiRow.className = 'emoji-row';

    const commentRow = document.createElement('div');
    commentRow.className = 'comment-row';
    const commentInput = document.createElement('input');
    commentInput.type = 'text';
    commentInput.placeholder = '+한마디';
    const commentBtn = document.createElement('button');
    commentBtn.type = 'button';
    commentBtn.textContent = '+한마디';
    commentRow.appendChild(commentInput);
    commentRow.appendChild(commentBtn);

    actions.appendChild(emojiRow);
    actions.appendChild(commentRow);

    wrap.appendChild(img);
    wrap.appendChild(pinballLayer);
    wrap.appendChild(danmaku);
    wrap.appendChild(voteBurstLayer);
    wrap.appendChild(destroyStreakLayer);
    wrap.appendChild(actions);
    card.appendChild(title);
    card.appendChild(wrap);
    menusEl.appendChild(card);

    // --- per-card state (shared via Firestore) ---
    // 댓글/이모지 저장·표시는 "항상 오늘(KST)" 기준으로 맞춥니다.
    const dateStr = todayDateKorea();

    const rid = r.id || titleLeft.textContent;
    let state = {
      emojiCounts: {},
      liveEmojiCounts: {},
      sacrificedEmojiCounts: {},
      emojiCrownMerge: {},
      comments: [],
    };
    let voteCombo = 0;
    let voteComboLastAt = 0;
    let comboStampSeq = 0;
    let warningLastAt = 0;
    let destroyComboCount = 0;
    let destroyMessageStageAt = 0;
    let destroyMessageTimer = null;

    const restaurantDocRef = doc(db, 'menus', 'current', 'restaurants', rid);
    const commentsColRef = collection(db, 'menus', 'current', 'restaurants', rid, 'comments');

    /** @type {{ id: string; birthSeq: number; el: HTMLElement; emoji: string; x: number; y: number; vx: number; vy: number; w: number; h: number }[]} */
    let pinballs = [];
    let pinballRafId = null;
    let pinballLayoutAttempts = 0;
    let pinballBirthSeq = 0;

    /** 희생(sacrificedEmojiCounts) ack 전 배치 */
    let sacrificePersistTimer = null;
    const sacrificePersistPending = {};
    let mergePersistTimer = null;
    const mergePersistPending = {};

    // liveEmojiCounts(출격 가능 수) 증감 pending(낙관 반영용)
    const pendingLiveDelta = {};
    const lastServerLive = {};
    let livePersistTimer = null;
    const livePersistPending = {};

    function applyOptimisticLiveDelta(emoji, delta) {
      if (!delta) return;
      const em = emoji;
      pendingLiveDelta[em] = (pendingLiveDelta[em] || 0) + delta;
      const prev = Math.max(0, Math.floor(Number(state.liveEmojiCounts[em]) || 0));
      const next = Math.max(0, prev + delta);
      const m = { ...state.liveEmojiCounts };
      if (next <= 0) delete m[em];
      else m[em] = next;
      state.liveEmojiCounts = m;
    }

    function flushLivePersistToFirestore() {
      const keys = Object.keys(livePersistPending);
      if (keys.length === 0) return;
      const upd = { updatedAt: serverTimestamp() };
      let hasField = false;
      for (const em of keys) {
        const n = livePersistPending[em];
        delete livePersistPending[em];
        if (!n) continue;
        hasField = true;
        upd[`liveEmojiCounts.${em}`] = increment(n);
      }
      if (!hasField) return;
      updateDoc(restaurantDocRef, upd)
        .catch((err) => {
          console.warn('[pinball] liveEmojiCounts updateDoc 실패, setDoc 후 재시도:', err);
          return setDoc(
            restaurantDocRef,
            { date: dateStr, updatedAt: serverTimestamp() },
            { merge: true },
          ).then(() => updateDoc(restaurantDocRef, upd));
        })
        .catch((err) => console.error(err));
    }

    function scheduleLivePersist(emoji, delta) {
      if (!delta) return;
      livePersistPending[emoji] = (livePersistPending[emoji] || 0) + delta;
      if (livePersistTimer != null) window.clearTimeout(livePersistTimer);
      livePersistTimer = window.setTimeout(() => {
        livePersistTimer = null;
        flushLivePersistToFirestore();
      }, 55);
    }

    function stopPinballLoop() {
      if (pinballRafId != null) {
        cancelAnimationFrame(pinballRafId);
        pinballRafId = null;
      }
    }

    function createPinballBall(emoji, W, H) {
      pinballBirthSeq += 1;
      const id =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `pb_${rid}_${pinballBirthSeq}_${Math.random().toString(36).slice(2)}`;
      const el = document.createElement('div');
      el.className = 'emoji-pinball-ball';
      const faceEl = document.createElement('span');
      faceEl.className = 'emoji-pinball-face';
      faceEl.textContent = emoji;
      const crownEl = document.createElement('span');
      crownEl.className = 'emoji-pinball-crown';
      crownEl.textContent = '👑';
      crownEl.setAttribute('aria-hidden', 'true');
      crownEl.hidden = true;
      el.appendChild(faceEl);
      el.appendChild(crownEl);
      pinballLayer.appendChild(el);
      const w0 = Math.max(el.offsetWidth, 20);
      const h0 = Math.max(el.offsetHeight, 20);
      const speed =
        PINBALL_SPEED_MIN + Math.random() * (PINBALL_SPEED_MAX - PINBALL_SPEED_MIN);
      const angle = Math.random() * Math.PI * 2;
      let vx = Math.cos(angle) * speed;
      let vy = Math.sin(angle) * speed;
      if (Math.abs(vx) < 0.35) vx += vx >= 0 ? 0.5 : -0.5;
      if (Math.abs(vy) < 0.35) vy += vy >= 0 ? 0.5 : -0.5;
      const x = Math.random() * Math.max(1, W - w0);
      const y = Math.random() * Math.max(1, H - h0);
      el.style.transform = `translate3d(${x}px,${y}px,0)`;
      return {
        id,
        birthSeq: pinballBirthSeq,
        el,
        faceEl,
        crownEl,
        _lastVisualLvl: null,
        _lastVisualCrown: null,
        emoji,
        x,
        y,
        vx,
        vy,
        w: w0,
        h: h0,
      };
    }

    function countPinballsForEmoji(emoji) {
      return pinballs.filter((b) => b.emoji === emoji).length;
    }

    function getCrownBallForEmoji(emoji) {
      const list = pinballs.filter((b) => b.emoji === emoji);
      if (list.length === 0) return null;
      return list.reduce((a, c) => (c.birthSeq < a.birthSeq ? c : a));
    }

    function isCrownBall(b) {
      const c = getCrownBallForEmoji(b.emoji);
      return !!c && c.id === b.id;
    }

    function getCrownLevelForEmoji(emoji) {
      return Math.min(
        CROWN_ABSORB_CAP,
        Math.max(0, Math.floor(Number(state.emojiCrownMerge[emoji]) || 0)),
      );
    }

    function setCrownLevelForEmoji(emoji, next) {
      const v = Math.min(CROWN_ABSORB_CAP, Math.max(0, Math.floor(Number(next) || 0)));
      const cur = getCrownLevelForEmoji(emoji);
      if (v === cur) return;
      state.emojiCrownMerge = { ...state.emojiCrownMerge, [emoji]: v };
      scheduleMergePersist(emoji, v - cur);
    }

    // 왕관(3~5단계)일수록 '묵직'하게(충돌에 덜 튕김)
    function crownMassFactorForBall(b) {
      if (!b) return 1;
      if (!isCrownBall(b)) return 1;
      const lvl = getCrownLevelForEmoji(b.emoji);
      if (lvl < 3) return 1;
      // 3:~1.35, 4:~1.7, 5:~2.05
      return Math.max(1, Math.min(2.2, 1 + (lvl - 2) * 0.35));
    }

    function prefersReducedMotion() {
      return (
        window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      );
    }

    function animateEvolution(el, kind) {
      if (!el || prefersReducedMotion()) return;
      // kind: 'up' | 'down'
      const isCrownEl =
        el.classList && el.classList.contains && el.classList.contains('emoji-pinball-crown');
      // 왕관은 가운데 정렬을 transform(translate)로 하고 있어서,
      // 애니메이션에서 transform을 덮어쓰면 잠깐 오른쪽으로 밀리는 현상이 생김.
      // -> translate는 유지하고 scale만 바뀌도록 keyframes를 구성한다.
      const baseT = isCrownEl ? 'translate(var(--crown-tx), var(--crown-ty)) ' : '';
      const kf =
        kind === 'down'
          ? [
              { transform: `${baseT}scale(1)`, filter: 'blur(0px)', opacity: 1 },
              { transform: `${baseT}scale(0.92)`, filter: 'blur(0.6px)', opacity: 0.98 },
              { transform: `${baseT}scale(1.03)`, filter: 'blur(0px)', opacity: 1 },
              { transform: `${baseT}scale(1)`, filter: 'blur(0px)', opacity: 1 },
            ]
          : [
              { transform: `${baseT}scale(1)`, filter: 'blur(0px)', opacity: 1 },
              { transform: `${baseT}scale(1.14)`, filter: 'blur(0.4px)', opacity: 1 },
              { transform: `${baseT}scale(0.98)`, filter: 'blur(0px)', opacity: 1 },
              { transform: `${baseT}scale(1)`, filter: 'blur(0px)', opacity: 1 },
            ];
      try {
        el.animate(kf, {
          duration: kind === 'down' ? 180 : 220,
          easing: 'cubic-bezier(0.2, 0.9, 0.2, 1)',
        });
      } catch {
        // ignore (older browsers)
      }
    }

    function refreshCrownDisplays() {
      for (const b of pinballs) {
        const crown = isCrownBall(b);
        const lvl = crown ? getCrownLevelForEmoji(b.emoji) : 0;
        const face = b.faceEl;
        const cr = b.crownEl;
        const wasCrown = b._lastVisualCrown;
        const wasLvl = b._lastVisualLvl;
        if (crown && lvl > 0) {
          /* 왕관·얼굴 크기 비율 튜닝. 위치는 index.html .emoji-pinball-crown 변수 */
          // 왕관(1~5단계) 얼굴 크기: 일반 대비 15% 크게
          const faceScale = 1.15;
          const faceBasePx = 22 + lvl * 6;
          const facePx = Math.min(52 * faceScale, Math.round(faceBasePx * faceScale));
          face.style.fontSize = `${facePx}px`;
          cr.hidden = false;
          // 왕관 크기: 기존(0.48배) 대비 1.5배(=0.72배)로 성장
          const crownPx = Math.min(45, Math.max(16, Math.round(facePx * 0.72)));
          cr.style.fontSize = `${crownPx}px`;

          if (wasLvl != null && wasLvl !== lvl) {
            animateEvolution(face, lvl > wasLvl ? 'up' : 'down');
            animateEvolution(cr, lvl > wasLvl ? 'up' : 'down');
          } else if (wasCrown === false) {
            // 새로 왕관이 됐을 때도 '진화' 느낌
            animateEvolution(face, 'up');
            animateEvolution(cr, 'up');
          }
        } else {
          face.style.fontSize = '';
          cr.hidden = true;
          cr.style.fontSize = '';

          // 왕관이 사라진 경우(레벨 0 또는 왕관 자리 변경)는 줄어드는 느낌
          if (wasCrown && crown === false) {
            animateEvolution(face, 'down');
          }
        }
        b._lastVisualCrown = crown && lvl > 0;
        b._lastVisualLvl = crown && lvl > 0 ? lvl : 0;
        b.w = Math.max(b.el.offsetWidth, 16);
        b.h = Math.max(b.el.offsetHeight, 16);
      }
    }

    function removeNewestPinballForEmoji(emoji) {
      const list = pinballs.filter((b) => b.emoji === emoji);
      if (list.length === 0) return;
      const victim = list.reduce((a, c) => (c.birthSeq > a.birthSeq ? c : a));
      const idx = pinballs.indexOf(victim);
      if (idx === -1) return;
      pinballs.splice(idx, 1);
      victim.el.remove();
    }

    // liveEmojiCounts: "출격 가능(현재 남아있는)" 수. 공(핀볼) 개수는 이것으로만 맞춘다.
    // emojiCounts: 누적 투표(기록용). 희생(sacrificed)은 별도 표시용.
    function buildPinballTargetCounts() {
      const target = {};
      for (const [e, raw] of Object.entries(state.liveEmojiCounts || {})) {
        const live = Math.floor(Number(raw) || 0);
        if (live <= 0) continue;
        target[e] = Math.min(live, PINBALL_MAX_PER_EMOJI);
      }
      return target;
    }

    let catchupUntil = 0;
    let catchupLevel = 0; // 0: off, 1: normal, 2: x3, 3: please...
    let lastSnapUpdatedMs = 0;
    function inCatchup() {
      return Date.now() < catchupUntil;
    }
    function beginCatchup(ms = 1200, level = 1) {
      catchupUntil = Math.max(catchupUntil, Date.now() + ms);
      catchupLevel = Math.max(catchupLevel, level);
    }
    function updateCatchupBadge() {
      if (!catchupBadge) return;
      const on = inCatchup();
      catchupBadge.classList.toggle('on', on);
      if (!on) {
        catchupLevel = 0;
        return;
      }
      if (catchupLevel >= 3) {
        catchupBadge.textContent =
          '동기화중입니다.. 제발 정상적으로 투표를 진행해주세요..';
      } else if (catchupLevel === 2) {
        catchupBadge.textContent = '동기화 가속 중.. x3';
      } else {
        catchupBadge.textContent = '동기화 중...';
      }
    }

    function orderedEmojiKeysForSync(target) {
      const set = new Set([...Object.keys(target), ...pinballs.map((b) => b.emoji)]);
      const extra = [...set].filter((e) => !EMOJIS.includes(e)).sort();
      return [...EMOJIS.filter((e) => set.has(e)), ...extra];
    }

    function syncEmojiPinballs() {
      const W = pinballLayer.clientWidth;
      const H = pinballLayer.clientHeight;
      if (W < 24 || H < 24) {
        if (pinballLayoutAttempts < 40) {
          pinballLayoutAttempts += 1;
          window.requestAnimationFrame(() => syncEmojiPinballs());
        }
        return;
      }
      pinballLayoutAttempts = 0;

      const target = buildPinballTargetCounts();
      const ordered = orderedEmojiKeysForSync(target);

      let needsChange = false;
      let totalGap = 0;
      for (const emoji of ordered) {
        const want = target[emoji] || 0;
        const have = countPinballsForEmoji(emoji);
        const gap = want - have;
        totalGap += Math.abs(gap);
        if (gap !== 0) needsChange = true;
      }
      // 격차가 크면 잠깐 빨리감기(뒤쳐진 사람 빠르게 따라잡기)
      // - 2~3: 약한 동기화
      // - 4~8: 가속(x3)
      // - 9+: 매우 많이 밀림(강한 문구)
      if (totalGap >= 9) beginCatchup(1700, 3);
      else if (totalGap >= 4) beginCatchup(1400, 2);
      else if (totalGap >= 2) beginCatchup(900, 1);
      // 거의 따라잡았으면 배지/캐치업을 빨리 끈다(계속 뜨는 현상 완화)
      if (totalGap <= 1) {
        catchupUntil = 0;
        catchupLevel = 0;
      }
      updateCatchupBadge();
      if (!needsChange) {
        refreshCrownDisplays();
        if (pinballs.length > 0) startPinballLoop();
        else stopPinballLoop();
        renderDebugPanel();
        return;
      }

      const fast = inCatchup();
      const perEmojiStep = fast ? 3 : 1;
      let ops = 0;
      const opsBudget = fast ? 40 : 12;
      for (const emoji of ordered) {
        const want = target[emoji] || 0;
        let have = countPinballsForEmoji(emoji);
        let guard = 0;
        while (have > want && ops < opsBudget && guard < 20) {
          const step = Math.min(perEmojiStep, have - want);
          for (let t = 0; t < step; t += 1) removeNewestPinballForEmoji(emoji);
          ops += step;
          have -= step;
          guard += 1;
        }
        guard = 0;
        while (have < want && ops < opsBudget && guard < 20) {
          const step = Math.min(perEmojiStep, want - have);
          for (let t = 0; t < step; t += 1) pinballs.push(createPinballBall(emoji, W, H));
          ops += step;
          have += step;
          guard += 1;
        }
      }

      refreshCrownDisplays();
      if (pinballs.length > 0) startPinballLoop();
      else stopPinballLoop();
      renderDebugPanel();

      // 아직 목표와 다르면 다음 프레임에서 이어서 맞춤(평소엔 부드럽게, 캐치업은 빠르게)
      if (ops >= opsBudget) {
        window.requestAnimationFrame(() => syncEmojiPinballs());
      }
    }

    function separateSameEmojiPair(A, B, W, H) {
      const cx = A.x + A.w / 2 - (B.x + B.w / 2);
      const cy = A.y + A.h / 2 - (B.y + B.h / 2);
      const d = Math.hypot(cx, cy) || 1;
      const mA = crownMassFactorForBall(A);
      const mB = crownMassFactorForBall(B);
      const push = 4;
      A.x += (cx / d) * (push / mA);
      A.y += (cy / d) * (push / mA);
      B.x -= (cx / d) * (push / mB);
      B.y -= (cy / d) * (push / mB);
      A.x = Math.max(0, Math.min(W - A.w, A.x));
      A.y = Math.max(0, Math.min(H - A.h, A.y));
      B.x = Math.max(0, Math.min(W - B.w, B.x));
      B.y = Math.max(0, Math.min(H - B.h, B.y));
      A.vx += (cx / d) * (1.2 / mA);
      A.vy += (cy / d) * (1.2 / mA);
      B.vx -= (cx / d) * (1.2 / mB);
      B.vy -= (cy / d) * (1.2 / mB);
    }

    function scheduleMergePersist(emoji, delta) {
      if (!delta) return;
      mergePersistPending[emoji] = (mergePersistPending[emoji] || 0) + delta;
      if (mergePersistTimer != null) window.clearTimeout(mergePersistTimer);
      mergePersistTimer = window.setTimeout(() => {
        mergePersistTimer = null;
        flushMergePersistToFirestore();
      }, 55);
    }

    function flushMergePersistToFirestore() {
      const keys = Object.keys(mergePersistPending);
      if (keys.length === 0) return;
      const upd = { updatedAt: serverTimestamp() };
      let has = false;
      for (const em of keys) {
        const d = mergePersistPending[em];
        delete mergePersistPending[em];
        if (!d) continue;
        has = true;
        upd[`emojiCrownMerge.${em}`] = increment(d);
      }
      if (!has) return;
      updateDoc(restaurantDocRef, upd)
        .catch((err) => {
          console.warn('[pinball] emojiCrownMerge updateDoc 실패:', err);
          return setDoc(
            restaurantDocRef,
            { date: dateStr, updatedAt: serverTimestamp() },
            { merge: true },
          ).then(() => updateDoc(restaurantDocRef, upd));
        })
        .catch((e) => console.error(e));
    }

    function persistCrownMergeReset(emoji) {
      const next = { ...state.emojiCrownMerge };
      delete next[emoji];
      state.emojiCrownMerge = next;
      updateDoc(restaurantDocRef, {
        [`emojiCrownMerge.${emoji}`]: 0,
        updatedAt: serverTimestamp(),
      })
        .catch((err) => console.error('[pinball] crown merge reset:', err));
    }

    function absorbSatelliteIntoCrown(satellite, crown, W, H) {
      const em = crown.emoji;
      const cur = Math.min(
        CROWN_ABSORB_CAP,
        Math.max(0, Math.floor(Number(state.emojiCrownMerge[em]) || 0)),
      );
      if (cur >= CROWN_ABSORB_CAP) return;
      const si = pinballs.indexOf(satellite);
      if (si === -1) return;
      // 자연스러운 흡수 연출: 위성은 시뮬레이션에서 즉시 제거하고, 고스트를 왕관으로 빨아들이듯 애니메이션
      const ghost = satellite.el.cloneNode(true);
      ghost.classList.add('emoji-absorb-ghost');
      ghost.style.pointerEvents = 'none';
      ghost.style.opacity = '1';
      ghost.style.filter = 'blur(0px)';
      ghost.style.transition = 'none';
      ghost.style.transform = `translate3d(${satellite.x}px,${satellite.y}px,0) scale(1)`;
      pinballLayer.appendChild(ghost);

      pinballs.splice(si, 1);
      satellite.el.remove();

      // 타겟은 왕관 중심으로
      const gw = Math.max(ghost.offsetWidth, 16);
      const gh = Math.max(ghost.offsetHeight, 16);
      const tx = crown.x + crown.w / 2 - gw / 2;
      const ty = crown.y + crown.h / 2 - gh / 2;
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          ghost.style.transition =
            'transform 0.24s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.24s ease-out, filter 0.24s ease-out';
          ghost.style.opacity = '0';
          ghost.style.filter = 'blur(2px)';
          ghost.style.transform = `translate3d(${tx}px,${ty}px,0) scale(0.15) rotate(0.12turn)`;
        });
      });
      window.setTimeout(() => {
        if (ghost.parentNode) ghost.remove();
      }, 280);

      state.emojiCrownMerge = { ...state.emojiCrownMerge, [em]: cur + 1 };
      scheduleMergePersist(em, 1);
      // 위성 1개가 흡수되며 필드에서 사라짐 = live -1, 희생 +1
      applyOptimisticLiveDelta(em, -1);
      scheduleLivePersist(em, -1);
      applyOptimisticSacrificeOne(em);
      scheduleSacrificePersist(em);
      refreshCrownDisplays();
      const dx = crown.x + crown.w / 2 - (W / 2);
      const dy = crown.y + crown.h / 2 - (H / 2);
      const d = Math.hypot(dx, dy) || 1;
      crown.vx -= (dx / d) * 0.6;
      crown.vy -= (dy / d) * 0.6;
    }

    function resolveSameEmojiInteractions(W, H) {
      for (let i = 0; i < pinballs.length; i += 1) {
        for (let j = i + 1; j < pinballs.length; j += 1) {
          const A = pinballs[i];
          const B = pinballs[j];
          if (A.emoji !== B.emoji) continue;
          if (!pinballsOverlap(A, B)) continue;
          const merge = Math.min(
            CROWN_ABSORB_CAP,
            Math.max(0, Math.floor(Number(state.emojiCrownMerge[A.emoji]) || 0)),
          );
          const crownA = isCrownBall(A);
          const crownB = isCrownBall(B);
          if (merge < CROWN_ABSORB_CAP && crownA && !crownB) {
            absorbSatelliteIntoCrown(B, A, W, H);
            return;
          }
          if (merge < CROWN_ABSORB_CAP && crownB && !crownA) {
            absorbSatelliteIntoCrown(A, B, W, H);
            return;
          }
          separateSameEmojiPair(A, B, W, H);
          return;
        }
      }
    }

    function pinballsOverlap(a, b) {
      return (
        a.x < b.x + b.w &&
        a.x + a.w > b.x &&
        a.y < b.y + b.h &&
        a.y + a.h > b.y
      );
    }

    function applyOptimisticSacrificeOne(emoji) {
      const em = emoji;
      const sp = Math.max(0, Math.floor(Number(state.sacrificedEmojiCounts[em]) || 0));
      state.sacrificedEmojiCounts = { ...state.sacrificedEmojiCounts, [em]: sp + 1 };
      renderTitleRight();
      syncEmojiPinballs();
    }

    function flushSacrificePersistToFirestore() {
      const keys = Object.keys(sacrificePersistPending);
      if (keys.length === 0) return;
      const upd = { updatedAt: serverTimestamp() };
      let hasField = false;
      for (const em of keys) {
        const n = sacrificePersistPending[em];
        delete sacrificePersistPending[em];
        if (!n || n <= 0) continue;
        hasField = true;
        upd[`sacrificedEmojiCounts.${em}`] = increment(n);
      }
      if (!hasField) return;

      updateDoc(restaurantDocRef, upd)
        .catch((err) => {
          console.warn('[pinball] sacrificedEmojiCounts updateDoc 실패, setDoc 후 재시도:', err);
          return setDoc(
            restaurantDocRef,
            { date: dateStr, updatedAt: serverTimestamp() },
            { merge: true },
          ).then(() => updateDoc(restaurantDocRef, upd));
        })
        .catch((err) => console.error(err));
    }

    function scheduleSacrificePersist(emoji) {
      sacrificePersistPending[emoji] = (sacrificePersistPending[emoji] || 0) + 1;
      if (sacrificePersistTimer != null) window.clearTimeout(sacrificePersistTimer);
      sacrificePersistTimer = window.setTimeout(() => {
        sacrificePersistTimer = null;
        flushSacrificePersistToFirestore();
      }, 55);
    }

    function getDestroyAlertByCount(count) {
      let picked = null;
      for (const item of DESTROY_STREAK_ALERTS) {
        if (count >= item.at) picked = item;
      }
      return picked;
    }

    function isVoteComboWindowActive(now = Date.now()) {
      return voteCombo > 0 && now - voteComboLastAt <= VOTE_COMBO_RESET_MS;
    }

    function hideDestroyStreakHud() {
      destroyHud.hidden = true;
      destroyHudNumber.textContent = '0';
      destroyMessageStageAt = 0;
      destroyMessageFx.hidden = true;
      destroyMessageFx.textContent = '';
      destroyMessageFx.classList.remove('impact', 'calm');
      if (destroyMessageTimer != null) {
        window.clearTimeout(destroyMessageTimer);
        destroyMessageTimer = null;
      }
    }

    function applyDestroyStyleTune() {
      destroyHud.style.setProperty('--destroy-grave-glow', DESTROY_HUD_STYLE_TUNE.graveGlow);
      destroyHud.style.setProperty('--destroy-number-glow', DESTROY_HUD_STYLE_TUNE.numberGlow);
      destroyMessageFx.style.setProperty('--destroy-message-glow', DESTROY_HUD_STYLE_TUNE.messageGlow);
      destroyMessageFx.style.setProperty('--destroy-message-stroke', DESTROY_HUD_STYLE_TUNE.messageStroke);
    }
    applyDestroyStyleTune();

    function showDestroyStageMessage(alert, calmMode) {
      destroyMessageFx.hidden = false;
      destroyMessageFx.textContent = alert.tagline || 'Unstoppable!!';
      destroyMessageFx.classList.toggle('calm', calmMode);
      destroyMessageFx.style.setProperty(
        '--destroy-msg-impact-ms',
        `${Math.max(120, DESTROY_MESSAGE_FX_TUNE.impactDurationMs)}ms`,
      );
      destroyMessageFx.classList.remove('impact');
      if (!calmMode) {
        // 강제 reflow(offsetWidth) 없이 다음 프레임에 애니메이션 재생
        window.requestAnimationFrame(() => {
          destroyMessageFx.classList.add('impact');
        });
      }

      if (destroyMessageTimer != null) window.clearTimeout(destroyMessageTimer);
      const showMs = calmMode
        ? Math.max(400, DESTROY_MESSAGE_FX_TUNE.calmShowMs)
        : alert.at === 500
        ? Math.max(300, DESTROY_MESSAGE_FX_TUNE.stage500ShowMs)
        : Math.max(300, DESTROY_MESSAGE_FX_TUNE.showMs);
      destroyMessageTimer = window.setTimeout(() => {
        destroyMessageTimer = null;
        destroyMessageFx.hidden = true;
        destroyMessageFx.textContent = '';
        destroyMessageFx.classList.remove('impact', 'calm');
      }, showMs);
    }

    function renderDestroyStreakHud(count) {
      const alert = getDestroyAlertByCount(count);
      if (!alert || !destroyStreakLayer || count < 10) {
        hideDestroyStreakHud();
        return;
      }

      destroyHud.hidden = false;
      destroyHudNumber.textContent = String(count);
      if (destroyMessageStageAt !== alert.at) {
        destroyMessageStageAt = alert.at;
        const lastStageAt = DESTROY_STREAK_ALERTS[DESTROY_STREAK_ALERTS.length - 1]?.at;
        showDestroyStageMessage(alert, alert.at === lastStageAt);
      }
    }

    function destroyLoserPinball(winner, loser, W, H) {
      const loserIsCrown = isCrownBall(loser);
      const li = pinballs.indexOf(loser);
      if (li === -1) return;

      pinballs.splice(li, 1);

      if (loserIsCrown) {
        persistCrownMergeReset(loser.emoji);
      }

      // 패배로 소멸: live -1, 희생 +1
      applyOptimisticLiveDelta(loser.emoji, -1);
      scheduleLivePersist(loser.emoji, -1);
      applyOptimisticSacrificeOne(loser.emoji);
      scheduleSacrificePersist(loser.emoji);
      const now = Date.now();
      // 파괴 콤보는 "투표 콤보 시간" 안에서만 누적/발동.
      // 콤보 창이 닫힌 상태(클릭 안 하는 시간)에서는 희생이 일어나도 배너를 띄우지 않습니다.
      if (!isVoteComboWindowActive(now)) {
        destroyComboCount = 0;
        hideDestroyStreakHud();
      } else {
        destroyComboCount += 1;
        renderDestroyStreakHud(destroyComboCount);
      }

      if (isCrownBall(winner)) {
        const wm = Math.floor(Number(state.emojiCrownMerge[winner.emoji]) || 0);
        if (wm > 0) {
          state.emojiCrownMerge = {
            ...state.emojiCrownMerge,
            [winner.emoji]: wm - 1,
          };
          scheduleMergePersist(winner.emoji, -1);
        }
      }

      const lx = loser.x;
      const ly = loser.y;
      const el = loser.el;
      el.style.pointerEvents = 'none';
      el.style.transition =
        'transform 0.22s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.22s ease-out';
      el.style.opacity = '1';
      el.style.filter = 'blur(0px)';
      el.style.transform = `translate3d(${lx}px,${ly}px,0) scale(1)`;
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          el.style.opacity = '0';
          el.style.filter = 'blur(2px)';
          el.style.transform = `translate3d(${lx}px,${ly}px,0) scale(0.06) rotate(0.4turn)`;
        });
      });
      window.setTimeout(() => {
        if (el.parentNode) el.remove();
      }, 260);

      const dx = winner.x + winner.w / 2 - (loser.x + loser.w / 2);
      const dy = winner.y + winner.h / 2 - (loser.y + loser.h / 2);
      const d = Math.hypot(dx, dy) || 1;
      const mw = crownMassFactorForBall(winner);
      const push = 5;
      // 묵직한 왕관(3~5단계)은 충돌 후 덜 튕기게(위치/속도 변화량 감소)
      winner.x += (dx / d) * (push / mw);
      winner.y += (dy / d) * (push / mw);
      winner.vx += (dx / d) * (2.4 / mw);
      winner.vy += (dy / d) * (2.4 / mw);
      winner.x = Math.max(0, Math.min(W - winner.w, winner.x));
      winner.y = Math.max(0, Math.min(H - winner.h, winner.y));

      refreshCrownDisplays();
    }

    function resolvePinballCollisionCross(W, H) {
      for (let i = 0; i < pinballs.length; i += 1) {
        for (let j = i + 1; j < pinballs.length; j += 1) {
          const A = pinballs[i];
          const B = pinballs[j];
          if (!pinballsOverlap(A, B)) continue;
          if (A.emoji === B.emoji) continue;
          const aIsCrown = isCrownBall(A) && getCrownLevelForEmoji(A.emoji) > 0;
          const bIsCrown = isCrownBall(B) && getCrownLevelForEmoji(B.emoji) > 0;

          // 왕관 vs 왕관(서로 다른 이모지): 둘 다 단계 -1
          if (aIsCrown && bIsCrown) {
            const aLvl = getCrownLevelForEmoji(A.emoji);
            const bLvl = getCrownLevelForEmoji(B.emoji);
            setCrownLevelForEmoji(A.emoji, aLvl - 1);
            setCrownLevelForEmoji(B.emoji, bLvl - 1);

            // 1단계 vs 1단계는 확률로 한쪽이 사라지게(결정전까지 계속 싸움)
            if (aLvl === 1 && bLvl === 1 && Math.random() < 0.5) {
              const loser = Math.random() < 0.5 ? A : B;
              const winner = loser === A ? B : A;
              destroyLoserPinball(winner, loser, W, H);
              return;
            }

            separateSameEmojiPair(A, B, W, H);
            refreshCrownDisplays();
            return;
          }

          // 왕관 vs 일반: 왕관은 단계 -1, 일반은 희생(삭제)
          if (aIsCrown !== bIsCrown) {
            const crownBall = aIsCrown ? A : B;
            const otherBall = aIsCrown ? B : A;
            const lvl = getCrownLevelForEmoji(crownBall.emoji);
            setCrownLevelForEmoji(crownBall.emoji, lvl - 1);
            destroyLoserPinball(crownBall, otherBall, W, H);
            return;
          }

          // 일반 vs 일반: 기존처럼 랜덤 1개 희생
          const loser = Math.random() < 0.5 ? A : B;
          const winner = loser === A ? B : A;
          destroyLoserPinball(winner, loser, W, H);
          return;
        }
      }
    }

    function stepPinballs() {
      const W = pinballLayer.clientWidth;
      const H = pinballLayer.clientHeight;
      if (W < 8 || H < 8) return;
      if (!isVoteComboWindowActive() && destroyComboCount !== 0) {
        destroyComboCount = 0;
        hideDestroyStreakHud();
      }

      for (const b of pinballs) {
        b.x += b.vx;
        b.y += b.vy;

        if (b.x <= 0) {
          b.x = 0;
          b.vx = Math.abs(b.vx) * (0.92 + Math.random() * 0.12);
        } else if (b.x + b.w >= W) {
          b.x = W - b.w;
          b.vx = -Math.abs(b.vx) * (0.92 + Math.random() * 0.12);
        }
        if (b.y <= 0) {
          b.y = 0;
          b.vy = Math.abs(b.vy) * (0.92 + Math.random() * 0.12);
        } else if (b.y + b.h >= H) {
          b.y = H - b.h;
          b.vy = -Math.abs(b.vy) * (0.92 + Math.random() * 0.12);
        }

        const mag = Math.hypot(b.vx, b.vy);
        const minS = PINBALL_SPEED_MIN * 0.85;
        if (mag < minS && mag > 0) {
          b.vx = (b.vx / mag) * minS;
          b.vy = (b.vy / mag) * minS;
        }
      }

      resolveSameEmojiInteractions(W, H);
      resolvePinballCollisionCross(W, H);

      for (const b of pinballs) {
        b.el.style.transform = `translate3d(${b.x}px,${b.y}px,0)`;
      }
    }

    function pinballLoop() {
      if (pinballs.length === 0) {
        pinballRafId = null;
        return;
      }
      if (!document.hidden) stepPinballs();
      pinballRafId = window.requestAnimationFrame(pinballLoop);
    }

    function startPinballLoop() {
      if (pinballRafId != null) return;
      pinballRafId = window.requestAnimationFrame(pinballLoop);
    }

    /** 제목 오른쪽: 희생 누적(흡수 + 다른 이모지에게 패배). 누적 투표수(emojiCounts)는 표시하지 않음 */
    function renderTitleRight() {
      titleRight.innerHTML = '';
      const entries = Object.entries(state.sacrificedEmojiCounts || {}).filter(
        ([, c]) => (c || 0) > 0,
      );
      if (entries.length === 0) return;

      entries.sort((a, b) => (b[1] || 0) - (a[1] || 0));

      for (const [e, c] of entries) {
        const count = Number(c) || 0;
        if (count <= 0) continue;
        const pill = document.createElement('span');
        pill.className = 'emoji-pill';
        pill.title = '희생 누적(왕관 흡수·다른 이모지와 충돌 패배)';
        const emojiSpan = document.createElement('span');
        emojiSpan.textContent = e;
        const cnt = document.createElement('span');
        cnt.className = 'count';
        cnt.textContent = String(count);
        pill.appendChild(emojiSpan);
        pill.appendChild(cnt);
        titleRight.appendChild(pill);
      }
    }

    function getEmojiDebugStats(e) {
      const votes = Math.floor(Number(state.emojiCounts?.[e]) || 0);
      const sacrificed = Math.floor(Number(state.sacrificedEmojiCounts?.[e]) || 0);
      const live = Math.floor(Number(state.liveEmojiCounts?.[e]) || 0);
      const want = Math.min(Math.max(0, live), PINBALL_MAX_PER_EMOJI);
      const have = countPinballsForEmoji(e);
      const crownLvl = getCrownLevelForEmoji(e);
      return { votes, sacrificed, live, want, have, crownLvl };
    }

    function renderDebugPanel() {
      if (!DEBUG_ENABLED || !debugEl) return;
      const lines = [];
      lines.push(`[debug] rid=${rid}  date=${dateStr}`);
      lines.push(
        `pinballs=${pinballs.length}  types=${new Set(pinballs.map((b) => b.emoji)).size}`,
      );
      lines.push('');
      lines.push('emoji   votes  sac  live  want  have  crown');
      for (const e of EMOJIS) {
        const s = getEmojiDebugStats(e);
        lines.push(
          `${e}      ${String(s.votes).padStart(4)}  ${String(s.sacrificed).padStart(3)}  ${String(s.live).padStart(4)}  ${String(s.want).padStart(4)}  ${String(s.have).padStart(4)}  ${String(s.crownLvl).padStart(5)}`,
        );
      }
      debugEl.hidden = false;
      debugEl.textContent = lines.join('\n');
    }

    function getNextVoteCombo() {
      const now = Date.now();
      if (now - voteComboLastAt > VOTE_COMBO_RESET_MS) {
        voteCombo = 0;
        destroyComboCount = 0;
        hideDestroyStreakHud();
      }
      voteCombo += 1;
      voteComboLastAt = now;
      return voteCombo;
    }

    function lerp(a, b, t) {
      return a + (b - a) * t;
    }

    function getComboPalette(combo) {
      // 1~100: 초록 -> 노랑 -> 주황 -> 빨강 -> 검정(연속 보간)
      const c = Math.max(1, Math.min(100, combo));
      const stops = [
        { at: 1, h: 132, s: 95, l: 54 },
        { at: 25, h: 52, s: 98, l: 58 },
        { at: 50, h: 28, s: 99, l: 54 },
        { at: 75, h: 2, s: 100, l: 52 },
        { at: 100, h: 0, s: 0, l: 7 },
      ];
      for (let i = 0; i < stops.length - 1; i += 1) {
        const a = stops[i];
        const b = stops[i + 1];
        if (c >= a.at && c <= b.at) {
          const t = (c - a.at) / (b.at - a.at || 1);
          return {
            h: lerp(a.h, b.h, t),
            s: lerp(a.s, b.s, t),
            l: lerp(a.l, b.l, t),
          };
        }
      }
      return { h: 0, s: 0, l: 7 };
    }

    function heatColorForCombo(combo, jitter = 0, alpha = 1) {
      const a = Math.max(0.15, Math.min(1, alpha));
      if (combo >= VOTE_COMBO_RAINBOW_STAGE) {
        const hueSeed = (Math.floor(Date.now() / 10) + combo * 19 + jitter * 7) % 360;
        return `hsl(${hueSeed} 100% 62% / ${a})`;
      }
      const base = getComboPalette(combo);
      const pulse = combo >= 60 ? Math.sin((combo + jitter) * 0.36) * 3.2 : 0;
      const h = (base.h + jitter * 0.12 + 360) % 360;
      const s = Math.max(0, Math.min(100, base.s + (combo >= 35 ? 2 : 0)));
      const l = Math.max(5, Math.min(72, base.l + pulse));
      return `hsl(${h} ${s}% ${l}% / ${a})`;
    }

    function comboLabelStyle(combo) {
      if (combo >= VOTE_COMBO_RAINBOW_STAGE) {
        // 100+ 콤보는 확실한 무지개(시간/콤보 모두 반영)
        const hue = (Math.floor(Date.now() / 8) + combo * 17) % 360;
        return {
          color: `hsl(${hue} 100% 66%)`,
          glowColor: `hsla(${(hue + 36) % 360} 100% 72% / 0.86)`,
          strokeColor: 'rgba(10, 10, 14, 0.9)',
          strokeWidth: combo >= 200 ? 1.45 : 1.2,
        };
      }
      const base = getComboPalette(combo);
      const nearBlack = combo >= 86;
      if (nearBlack) {
        return {
          color: 'hsl(0 0% 6%)',
          glowColor: 'rgba(255, 52, 52, 0.92)',
          strokeColor: 'rgba(255, 72, 72, 0.98)',
          strokeWidth: 1.38,
        };
      }
      const cHue = (base.h + 360) % 360;
      const cSat = Math.max(90, Math.min(100, base.s + 5));
      const cLight = Math.max(40, Math.min(66, base.l + 2));
      return {
        color: `hsl(${cHue} ${cSat}% ${cLight}%)`,
        glowColor: `hsla(${cHue} ${Math.min(100, cSat + 2)}% ${Math.min(74, cLight + 8)}% / 0.78)`,
        strokeColor: 'rgba(12, 14, 20, 0.9)',
        strokeWidth: 1.12,
      };
    }

    function spawnVoteBurst(combo, sourceEl, originPoint) {
      if (!voteBurstLayer) return;
      const layerRect = voteBurstLayer.getBoundingClientRect();
      if (layerRect.width <= 0 || layerRect.height <= 0) return;

      let originX = layerRect.width * 0.5;
      let originY = layerRect.height * 0.64;
      const hasPointer =
        originPoint &&
        Number.isFinite(originPoint.x) &&
        Number.isFinite(originPoint.y) &&
        originPoint.x > 0 &&
        originPoint.y > 0;
      if (hasPointer) {
        originX = originPoint.x - layerRect.left;
        originY = originPoint.y - layerRect.top;
      } else if (sourceEl instanceof HTMLElement) {
        const br = sourceEl.getBoundingClientRect();
        originX = br.left - layerRect.left + br.width / 2;
        originY = br.top - layerRect.top + br.height / 2;
      }
      originX += VOTE_FX_TUNE.originOffsetX;
      originY += VOTE_FX_TUNE.originOffsetY;

      const prefersReduce =
        window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const rainbowStage = combo >= VOTE_COMBO_RAINBOW_STAGE;
      const questionChance = rainbowStage ? 1 : 0;
      const rainbowPulseLv =
        combo >= 150 ? Math.max(0, Math.min(1, (combo - 150) / 220)) : 0;
      const rainbowColor = (seed = 0) => {
        const hue = (Math.floor(Date.now() / (12 - rainbowPulseLv * 5)) + combo * 24 + seed * 41) % 360;
        const pulse = Math.sin((Date.now() / 55 + seed * 0.8 + combo) * (1 + rainbowPulseLv * 0.8));
        const light = 60 + pulse * (8 + rainbowPulseLv * 12);
        return `hsl(${hue} 100% ${Math.max(44, Math.min(80, light))}%)`;
      };
      const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

      const spawnText = ({
        text,
        size,
        dx,
        dy,
        duration,
        delay,
        color,
        z = 0,
        textShadow,
        strokeWidth = 0,
        strokeColor = 'transparent',
        pulseStrength = 0,
      }) => {
        const el = document.createElement('span');
        el.className = 'vote-burst-text';
        el.textContent = text;
        el.style.left = `${originX}px`;
        el.style.top = `${originY}px`;
        el.style.fontSize = `${size}px`;
        el.style.color = color;
        el.style.zIndex = String(10 + z);
        if (textShadow) el.style.textShadow = textShadow;
        if (strokeWidth > 0) {
          el.style.webkitTextStroke = `${strokeWidth}px ${strokeColor}`;
        }
        voteBurstLayer.appendChild(el);

        const p = Math.max(0, Math.min(1, pulseStrength));
        const kf =
          p > 0
            ? [
                { transform: 'translate(0px, 0px) scale(0.5)', opacity: 0, filter: 'blur(1px)' },
                { offset: 0.16, transform: 'translate(0px, 0px) scale(1)', opacity: 1, filter: 'blur(0px)' },
                {
                  offset: 0.4,
                  transform: `translate(${Math.round(dx * 0.38)}px, ${Math.round(dy * 0.38)}px) scale(${1.04 + p * 0.18})`,
                  opacity: 1,
                  filter: 'blur(0px)',
                },
                {
                  offset: 0.58,
                  transform: `translate(${Math.round(dx * 0.56)}px, ${Math.round(dy * 0.56)}px) scale(${0.94 + p * 0.12})`,
                  opacity: 1,
                  filter: `blur(${0.1 + p * 0.25}px)`,
                },
                {
                  offset: 0.74,
                  transform: `translate(${Math.round(dx * 0.76)}px, ${Math.round(dy * 0.76)}px) scale(${1.08 + p * 0.24})`,
                  opacity: 1,
                  filter: 'blur(0px)',
                },
                {
                  transform: `translate(${Math.round(dx)}px, ${Math.round(dy + 28 + Math.random() * 22)}px) scale(0.82)`,
                  opacity: 0,
                  filter: 'blur(0.6px)',
                },
              ]
            : [
                { transform: 'translate(0px, 0px) scale(0.5)', opacity: 0, filter: 'blur(1px)' },
                { offset: 0.18, transform: 'translate(0px, 0px) scale(1)', opacity: 1, filter: 'blur(0px)' },
                {
                  offset: 0.68,
                  transform: `translate(${Math.round(dx * 0.72)}px, ${Math.round(dy * 0.72)}px) scale(1.08)`,
                  opacity: 1,
                  filter: 'blur(0px)',
                },
                {
                  transform: `translate(${Math.round(dx)}px, ${Math.round(dy + 28 + Math.random() * 22)}px) scale(0.82)`,
                  opacity: 0,
                  filter: 'blur(0.6px)',
                },
              ];
        const anim = el.animate(kf, {
          duration,
          delay,
          easing: 'cubic-bezier(0.2, 0.9, 0.2, 1)',
          fill: 'forwards',
        });
        anim.onfinish = () => el.remove();
        window.setTimeout(() => {
          if (el.parentNode) el.remove();
        }, duration + delay + 220);
      };

      const spawnComboStamp = (text, style) => {
        comboStampSeq += 1;
        const lane = comboStampSeq % 4;
        // 300+부터 100단위로 콤보 타격감 강화 (300/400/500...)
        const comboImpactTier = combo >= 300 ? Math.floor((combo - 300) / 100) + 1 : 0;
        const x = clamp(
          originX + VOTE_FX_TUNE.comboOffsetX + Math.random() * VOTE_FX_TUNE.comboJitterX,
          VOTE_FX_TUNE.edgePadding,
          layerRect.width - VOTE_FX_TUNE.edgePadding,
        );
        const y = clamp(
          originY +
            VOTE_FX_TUNE.comboOffsetY -
            lane * VOTE_FX_TUNE.comboLaneGapY +
            Math.random() * VOTE_FX_TUNE.comboJitterY,
          VOTE_FX_TUNE.edgePadding,
          layerRect.height - VOTE_FX_TUNE.edgePadding,
        );
        const el = document.createElement('span');
        el.className = 'vote-burst-text';
        el.textContent = text;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.fontSize = `${(combo >= 100 ? 30 : Math.min(24, 14 + Math.floor(combo * 0.34))) + Math.min(10, comboImpactTier * 1.4)}px`;
        el.style.color = style.color;
        el.style.zIndex = '30';
        el.style.textShadow =
          `0 2px 12px rgba(0,0,0,0.62), 0 0 18px ${style.glowColor}, 0 0 32px ${style.glowColor}`;
        el.style.webkitTextStroke = `${style.strokeWidth + Math.min(1.1, comboImpactTier * 0.18)}px ${style.strokeColor}`;
        voteBurstLayer.appendChild(el);
        const anim = el.animate(
          comboImpactTier > 0
            ? [
                { transform: 'translate(0, 16px) scale(0.62)', opacity: 0 },
                {
                  offset: 0.18,
                  transform: `translate(0, 2px) scale(${1.28 + comboImpactTier * 0.08 + rainbowPulseLv * 0.24})`,
                  opacity: 1,
                },
                {
                  offset: 0.34,
                  transform: `translate(0, -1px) scale(${0.9 + comboImpactTier * 0.04})`,
                  opacity: 1,
                },
                {
                  offset: 0.5,
                  transform: `translate(0, -3px) scale(${1.18 + comboImpactTier * 0.06 + rainbowPulseLv * 0.2})`,
                  opacity: 1,
                },
                {
                  offset: 0.72,
                  transform: `translate(0, -4px) scale(${1.02 + comboImpactTier * 0.03 + rainbowPulseLv * 0.18})`,
                  opacity: 1,
                },
                { transform: 'translate(0, -10px) scale(0.9)', opacity: 0 },
              ]
            : [
                { transform: 'translate(0, 10px) scale(0.72)', opacity: 0 },
                {
                  offset: 0.24,
                  transform: `translate(0, 0px) scale(${1.06 + rainbowPulseLv * 0.2})`,
                  opacity: 1,
                },
                {
                  offset: 0.48,
                  transform: `translate(0, -2px) scale(${1 + rainbowPulseLv * 0.26})`,
                  opacity: 1,
                },
                {
                  offset: 0.7,
                  transform: `translate(0, -3px) scale(${1.02 + rainbowPulseLv * 0.32})`,
                  opacity: 1,
                },
                { transform: 'translate(0, -8px) scale(0.92)', opacity: 0 },
              ],
          {
            duration:
              comboImpactTier > 0
                ? Math.max(
                    480,
                    (combo >= 100 ? Math.max(620, 860 - Math.round(rainbowPulseLv * 140)) : 680) -
                      comboImpactTier * 45,
                  )
                : combo >= 100
                ? Math.max(620, 860 - Math.round(rainbowPulseLv * 140))
                : 680,
            easing: 'cubic-bezier(0.2, 0.9, 0.2, 1)',
            fill: 'forwards',
          },
        );
        anim.onfinish = () => el.remove();
        window.setTimeout(() => {
          if (el.parentNode) el.remove();
        }, (combo >= 100 ? 860 : 680) + 220);

        // 타격감 tier가 있으면 잔상 스탬프를 한 번 더 찍어 "팡팡" 느낌 강화
        if (comboImpactTier > 0) {
          const echo = document.createElement('span');
          echo.className = 'vote-burst-text';
          echo.textContent = text;
          echo.style.left = `${x + 2}px`;
          echo.style.top = `${y + 1}px`;
          echo.style.fontSize = `${(combo >= 100 ? 30 : Math.min(24, 14 + Math.floor(combo * 0.34))) + Math.min(12, comboImpactTier * 1.6)}px`;
          echo.style.color = style.color;
          echo.style.zIndex = '29';
          echo.style.opacity = '0.75';
          echo.style.textShadow = `0 0 ${14 + comboImpactTier * 3}px ${style.glowColor}`;
          echo.style.webkitTextStroke = `${style.strokeWidth}px ${style.strokeColor}`;
          voteBurstLayer.appendChild(echo);
          const echoAnim = echo.animate(
            [
              { transform: 'translate(0, 8px) scale(0.7)', opacity: 0 },
              { offset: 0.28, transform: `translate(0, -1px) scale(${1.18 + comboImpactTier * 0.08})`, opacity: 0.72 },
              { transform: 'translate(0, -8px) scale(0.88)', opacity: 0 },
            ],
            {
              duration: Math.max(360, 560 - comboImpactTier * 35),
              delay: 28,
              easing: 'cubic-bezier(0.2, 0.9, 0.2, 1)',
              fill: 'forwards',
            },
          );
          echoAnim.onfinish = () => echo.remove();
          window.setTimeout(() => {
            if (echo.parentNode) echo.remove();
          }, 760);
        }
      };

      const spawnLikeRise = (text, color) => {
        const el = document.createElement('span');
        el.className = 'vote-burst-text';
        el.textContent = text;
        el.style.left = `${originX}px`;
        el.style.top = `${originY}px`;
        el.style.fontSize = '26px';
        el.style.color = color;
        el.style.zIndex = '26';
        el.style.textShadow =
          '0 2px 10px rgba(0,0,0,0.55), 0 0 14px rgba(255,255,255,0.25)';
        el.style.webkitTextStroke = '0.6px rgba(8, 8, 8, 0.5)';
        voteBurstLayer.appendChild(el);
        const anim = el.animate(
          [
            { transform: 'translate(0px, 0px) scale(0.72)', opacity: 0 },
            { offset: 0.2, transform: 'translate(0px, -4px) scale(1.08)', opacity: 1 },
            { offset: 0.55, transform: 'translate(0px, -18px) scale(1)', opacity: 1 },
            { transform: 'translate(0px, -46px) scale(0.94)', opacity: 0 },
          ],
          {
            duration: 980,
            easing: 'cubic-bezier(0.18, 0.85, 0.22, 1)',
            fill: 'forwards',
          },
        );
        anim.onfinish = () => el.remove();
        window.setTimeout(() => {
          if (el.parentNode) el.remove();
        }, 1250);
      };

      const triggerWarningAlert = () => {
        if (combo < 150 || prefersReduce) return;
        const now = Date.now();
        if (now - warningLastAt < VOTE_FX_TUNE.warningCooldownMs) return;
        warningLastAt = now;
        const lv = Math.max(0, Math.min(1, (combo - 150) / 220));
        // 150 이후 50콤보 단위로 강도 업 (150~199:0, 200~249:1, 250~299:2 ...)
        const tier50 = Math.max(0, Math.floor((combo - 150) / 50));
        // 500 이후 25콤보 단위로 흔들림 강도 업
        const shakeTier25 = combo >= 500 ? Math.floor((combo - 500) / 25) + 1 : 0;
        const shakeAmpX = Math.min(18, shakeTier25 * 1.35);
        const shakeAmpY = Math.min(10, shakeTier25 * 0.8);
        const mixX = Math.max(0, Math.min(1, VOTE_FX_TUNE.warningAnchorMixX));
        const mixY = Math.max(0, Math.min(1, VOTE_FX_TUNE.warningAnchorMixY));
        const comboBaseX = originX + VOTE_FX_TUNE.comboOffsetX;
        const comboBaseY = originY + VOTE_FX_TUNE.comboOffsetY;
        const anchorX =
          originX + (comboBaseX - originX) * mixX + VOTE_FX_TUNE.warningOffsetX;
        const anchorY =
          originY + (comboBaseY - originY) * mixY + VOTE_FX_TUNE.warningOffsetY;

        const warn = document.createElement('span');
        warn.className = 'vote-burst-text';
        warn.textContent = 'Warning! Warning!';
        warn.style.left = `${clamp(anchorX, VOTE_FX_TUNE.edgePadding, layerRect.width - VOTE_FX_TUNE.edgePadding)}px`;
        // 문구는 빛보다 위에 보이도록 살짝 위로
        warn.style.top = `${clamp(anchorY - 10, VOTE_FX_TUNE.edgePadding, layerRect.height - VOTE_FX_TUNE.edgePadding)}px`;
        warn.style.fontWeight = '900';
        warn.style.fontSize = `${17 + lv * 9 + tier50 * 2.2}px`;
        warn.style.letterSpacing = '0.03em';
        warn.style.zIndex = '36';
        warn.style.color = 'hsl(0 100% 56%)';
        warn.style.webkitTextStroke = `${1 + Math.min(1.5, tier50 * 0.28)}px rgba(12, 12, 12, 0.92)`;
        warn.style.textShadow =
          `0 2px 10px rgba(0,0,0,0.82), 0 0 ${14 + Math.min(16, tier50 * 3)}px rgba(255,40,40,0.86), 0 0 ${24 + Math.min(26, tier50 * 4)}px rgba(255,40,40,0.56)`;
        voteBurstLayer.appendChild(warn);

        const travel =
          (VOTE_FX_TUNE.warningTravelX + lv * 42) *
          Math.max(0.1, VOTE_FX_TUNE.warningTravelScale);
        const dur = Math.max(1200, Math.round(VOTE_FX_TUNE.warningDurationMs + lv * 700));
        const warnAnim = warn.animate(
          [
            {
              transform: `translate(${travel}px, 0px) scale(${0.96 + lv * 0.08})`,
              opacity: 0,
            },
            {
              offset: 0.12,
              transform: `translate(${travel * 0.74}px, ${-shakeAmpY}px) scale(${1.02 + lv * 0.08})`,
              opacity: 1,
            },
            {
              offset: 0.28,
              transform: `translate(${travel * 0.48 - shakeAmpX}px, ${shakeAmpY}px) scale(${1.03 + lv * 0.1})`,
              opacity: 0.34,
            },
            {
              offset: 0.42,
              transform: `translate(${travel * 0.22 + shakeAmpX}px, ${-shakeAmpY}px) scale(${1.05 + lv * 0.12})`,
              opacity: 1,
            },
            {
              offset: 0.56,
              transform: `translate(${-travel * 0.08 - shakeAmpX}px, ${shakeAmpY}px) scale(${1.03 + lv * 0.09})`,
              opacity: 0.36,
            },
            {
              offset: 0.7,
              transform: `translate(${-travel * 0.38 + shakeAmpX}px, ${-shakeAmpY}px) scale(${1.02 + lv * 0.08})`,
              opacity: 1,
            },
            {
              offset: 0.84,
              transform: `translate(${-travel * 0.68 - shakeAmpX}px, ${shakeAmpY}px) scale(0.98)`,
              opacity: 0.46,
            },
            {
              transform: `translate(${-travel}px, ${-shakeAmpY * 0.5}px) scale(0.9)`,
              opacity: 0,
            },
          ],
          {
            duration: dur,
            easing: 'linear',
            fill: 'forwards',
          },
        );
        warnAnim.onfinish = () => warn.remove();

        const beacon = document.createElement('span');
        beacon.className = 'vote-burst-text';
        beacon.textContent = '';
        beacon.style.display = 'block';
        beacon.style.left = `${clamp(anchorX, VOTE_FX_TUNE.edgePadding, layerRect.width - VOTE_FX_TUNE.edgePadding)}px`;
        // 빛은 문구 아래 배경으로
        beacon.style.top = `${clamp(anchorY + 4, VOTE_FX_TUNE.edgePadding, layerRect.height - VOTE_FX_TUNE.edgePadding)}px`;
        const w = 124 + lv * 86 + Math.min(84, tier50 * 12);
        const h = 34 + lv * 18 + Math.min(26, tier50 * 4);
        beacon.style.width = `${w}px`;
        beacon.style.height = `${h}px`;
        beacon.style.marginLeft = `${-w / 2}px`;
        beacon.style.marginTop = `${-h / 2}px`;
        beacon.style.borderRadius = '999px';
        beacon.style.zIndex = '33';
        beacon.style.background =
          'linear-gradient(90deg, rgba(255,25,25,0.58), rgba(8,8,10,0.2) 32%, rgba(255,25,25,0.68) 52%, rgba(8,8,10,0.2) 74%, rgba(255,25,25,0.58))';
        beacon.style.filter = `blur(${1 + lv * 1.3 + Math.min(1.8, tier50 * 0.28)}px)`;
        beacon.style.boxShadow =
          `0 0 ${20 + Math.min(18, tier50 * 3)}px rgba(255,30,30,0.6), 0 0 ${28 + Math.min(22, tier50 * 3.5)}px rgba(0,0,0,0.48)`;
        voteBurstLayer.appendChild(beacon);
        const beaconAnim = beacon.animate(
          [
            {
              transform: `translate(${travel}px,0px) scaleX(0.5)`,
              opacity: 0,
            },
            {
              offset: 0.14,
              transform: `translate(${travel * 0.7}px,${-shakeAmpY * 0.65}px) scaleX(1)`,
              opacity: 0.78,
            },
            {
              offset: 0.33,
              transform: `translate(${travel * 0.36 - shakeAmpX * 0.8}px,${shakeAmpY * 0.65}px) scaleX(1.08)`,
              opacity: 0.34,
            },
            {
              offset: 0.52,
              transform: `translate(${travel * 0.02 + shakeAmpX * 0.8}px,${-shakeAmpY * 0.65}px) scaleX(1.12)`,
              opacity: 0.8,
            },
            {
              offset: 0.72,
              transform: `translate(${-travel * 0.42 - shakeAmpX * 0.8}px,${shakeAmpY * 0.65}px) scaleX(1.06)`,
              opacity: 0.32,
            },
            {
              offset: 0.88,
              transform: `translate(${-travel * 0.76 + shakeAmpX * 0.8}px,${-shakeAmpY * 0.65}px) scaleX(0.92)`,
              opacity: 0.7,
            },
            { transform: `translate(${-travel}px,${shakeAmpY * 0.3}px) scaleX(0.56)`, opacity: 0 },
          ],
          {
            duration: dur,
            easing: 'linear',
            fill: 'forwards',
          },
        );
        beaconAnim.onfinish = () => beacon.remove();
      };

      const triggerHeavyHit = () => {
        if (combo < 200 || prefersReduce) return;
        const lv = Math.max(0, Math.min(1, (combo - 200) / 280));
        try {
          voteBurstLayer.animate(
            [
              { transform: 'translate3d(0px,0px,0) scale(1)' },
              {
                offset: 0.25,
                transform: `translate3d(${(Math.random() - 0.5) * (6 + lv * 8)}px, ${(Math.random() - 0.5) * (4 + lv * 6)}px,0) scale(${1 + lv * 0.03})`,
              },
              { transform: 'translate3d(0px,0px,0) scale(1)' },
            ],
            {
              duration: Math.max(90, 140 - lv * 35),
              easing: 'cubic-bezier(0.2, 0.9, 0.2, 1)',
            },
          );
        } catch {
          // ignore
        }

        const ring = document.createElement('span');
        ring.className = 'vote-burst-text';
        ring.textContent = '';
        ring.style.left = `${originX}px`;
        ring.style.top = `${originY}px`;
        ring.style.display = 'block';
        ring.style.width = `${26 + lv * 22}px`;
        ring.style.height = `${26 + lv * 22}px`;
        ring.style.marginLeft = `${-(13 + lv * 11)}px`;
        ring.style.marginTop = `${-(13 + lv * 11)}px`;
        ring.style.borderRadius = '999px';
        ring.style.border = `${1.5 + lv * 1.8}px solid rgba(255,255,255,0.9)`;
        ring.style.boxShadow =
          `0 0 16px rgba(255,255,255,0.48), 0 0 30px rgba(255,64,64,${0.46 + lv * 0.34})`;
        ring.style.background = 'transparent';
        ring.style.zIndex = '36';
        voteBurstLayer.appendChild(ring);
        const ringAnim = ring.animate(
          [
            { transform: 'scale(0.3)', opacity: 0.9, filter: 'blur(0px)' },
            { transform: `scale(${1.2 + lv * 0.85})`, opacity: 0, filter: 'blur(0.7px)' },
          ],
          {
            duration: Math.max(130, 220 - lv * 60),
            easing: 'cubic-bezier(0.2, 0.9, 0.2, 1)',
            fill: 'forwards',
          },
        );
        ringAnim.onfinish = () => ring.remove();
        window.setTimeout(() => {
          if (ring.parentNode) ring.remove();
        }, 320);
      };

      const mainText = rainbowStage ? '?' : Math.random() < questionChance ? '?' : '+1';
      if (!rainbowStage && combo <= 10) {
        // 초반 1~10은 콤보감보다 "좋아요 버튼" 같은 단독 상승 느낌
        spawnLikeRise(mainText, heatColorForCombo(combo, Math.random() * 6 - 3));
      } else {
        spawnText({
          text: mainText,
          size: Math.min(34, 22 + Math.floor(combo * 0.8)),
          dx: (Math.random() - 0.5) * 26,
          // +1은 클릭 좌표 근처에서 시작해 살짝 위로만
          dy: -34 - Math.min(28, combo * 1.1),
          duration: Math.max(360, 620 - combo * 8),
          delay: 0,
          color: rainbowStage
            ? rainbowColor()
            : heatColorForCombo(combo, Math.random() * 10 - 5),
          pulseStrength: rainbowStage ? rainbowPulseLv : 0,
          z: 2,
        });
      }
      if (combo >= 11) {
        // 10콤보 이후에는 분사 수를 점진적으로 늘려 타격감을 살립니다.
        const sprayText = combo >= VOTE_COMBO_RAINBOW_STAGE ? '?' : '+1';
        const sprayCount =
          combo >= VOTE_COMBO_RAINBOW_STAGE
            ? Math.min(12, 3 + Math.floor((combo - VOTE_COMBO_RAINBOW_STAGE) / 18))
            : Math.min(5, 1 + Math.floor((combo - 11) / 20));
        for (let i = 0; i < sprayCount; i += 1) {
          const spread = Math.min(140, 36 + combo * 0.55);
          const rise = Math.min(110, 44 + combo * 0.42);
          spawnText({
            text: sprayText,
            size: combo >= VOTE_COMBO_RAINBOW_STAGE ? 22 + Math.min(14, combo * 0.03) : 15 + Math.min(8, combo * 0.07),
            dx: (Math.random() - 0.5) * spread,
            dy: -(12 + Math.random() * rise),
            duration: combo >= VOTE_COMBO_RAINBOW_STAGE ? Math.max(360, 760 - combo * 1.4) : Math.max(320, 560 - combo * 3),
            delay: i * 18 + Math.random() * 55,
            color: rainbowStage
              ? rainbowColor(i + 1)
              : heatColorForCombo(combo, Math.random() * 16 - 8),
            pulseStrength: rainbowStage ? Math.min(1, 0.35 + rainbowPulseLv * 0.8) : 0,
            z: 1,
          });
        }
      }

      triggerWarningAlert();
      triggerHeavyHit();

      if (combo >= 11 && !rainbowStage) {
        spawnComboStamp(`x${combo}`, comboLabelStyle(combo));
      }

      if (combo >= VOTE_COMBO_RAINBOW_STAGE) {
        const tier = Math.floor(combo / 100);
        const marks = '!'.repeat(Math.max(1, Math.min(8, tier)));
        spawnComboStamp(`x${combo}${marks}`, comboLabelStyle(combo));
      }

      // 회오리처럼 퍼지는 보조 파티클은 제거(요청사항)
    }

    function renderEmojiButtons() {
      emojiRow.innerHTML = '';
      for (const e of EMOJIS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'emoji-btn';
        b.textContent = e;
        // 공용 투표라 active 표시는 하지 않음(로그인 없이 개인 상태 추적 불가)
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const combo = getNextVoteCombo();
          const source = ev.currentTarget instanceof HTMLElement ? ev.currentTarget : null;
          const pointer =
            Number.isFinite(ev.clientX) && Number.isFinite(ev.clientY)
              ? { x: ev.clientX, y: ev.clientY }
              : null;
          spawnVoteBurst(combo, source, pointer);
          // 클릭 즉시 로컬에 낙관적 반영(스냅샷/네트워크 딜레이 체감 감소)
          const prev = Math.max(0, Math.floor(Number(state.emojiCounts[e]) || 0));
          state.emojiCounts = { ...state.emojiCounts, [e]: prev + 1 };
          applyOptimisticLiveDelta(e, 1);
          syncEmojiPinballs();
          renderDebugPanel();
          if (DEBUG_ENABLED) console.debug('[debug][vote-click]', rid, e, getEmojiDebugStats(e));

          // 중복 투표: 클릭할 때마다 +1 (Firestore에 누적)
          // updateDoc은 문서가 없으면 실패하므로 setDoc으로 베이스를 먼저 만들어두고 updateDoc 수행
          setDoc(
            restaurantDocRef,
            { date: dateStr, updatedAt: serverTimestamp() },
            { merge: true },
          )
            .then(() =>
              updateDoc(restaurantDocRef, {
                [`emojiCounts.${e}`]: increment(1),
                [`liveEmojiCounts.${e}`]: increment(1),
                updatedAt: serverTimestamp(),
              }),
            )
            .catch((err) => console.error(err));
        });
        emojiRow.appendChild(b);
      }
    }

    function isSameTextFlying(text) {
      for (const el of danmaku.querySelectorAll('span.danmaku-line')) {
        if (el.textContent === text) return true;
      }
      return false;
    }

    function spawnDanmaku(text) {
      if (isSameTextFlying(text)) return;

      const span = document.createElement('span');
      span.className = 'danmaku-line';
      span.textContent = text;
      span.style.color = randomColor();
      span.style.top = `${Math.floor(Math.random() * 70) + 8}%`;
      span.style.position = 'absolute';
      span.style.left = '0';
      span.style.animation = 'none';
      span.style.willChange = 'transform';

      danmaku.appendChild(span);
      const cw = danmaku.clientWidth;
      const sw = Math.max(span.offsetWidth, 1);
      const distancePx = cw + sw + 16;
      const v =
        DANMAKU_PX_PER_SEC_MIN +
        Math.random() * (DANMAKU_PX_PER_SEC_MAX - DANMAKU_PX_PER_SEC_MIN);
      const durationSec = distancePx / v;

      span.style.transform = `translateX(${cw}px)`;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          span.style.transition = `transform ${durationSec}s linear`;
          span.style.transform = `translateX(${-sw}px)`;
        });
      });

      let cleaned = false;
      const finish = () => {
        if (cleaned) return;
        cleaned = true;
        span.removeEventListener('transitionend', onEnd);
        span.remove();
      };
      const onEnd = (ev) => {
        if (ev.propertyName !== 'transform') return;
        finish();
      };
      span.addEventListener('transitionend', onEnd);
      window.setTimeout(finish, durationSec * 1000 + 400);
    }

    function startDanmakuLoop() {
      // 같은 문구는 화면에 하나만(겹침 없음). 사라지면 이후 틱에서 다시 나올 수 있음(일일 반복 제한 없음).
      const tick = () => {
        if (!state.comments || state.comments.length === 0) return;
        const candidates = state.comments.filter((c) => !isSameTextFlying(c.text));
        if (candidates.length === 0) return;
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        spawnDanmaku(pick.text);
      };

      setInterval(() => {
        if (document.hidden) return;
        if (Math.random() < 0.7) tick();
      }, 1800);
    }

    commentBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const text = commentInput.value.trim();
      if (!text) return;
      // 공유 코멘트 저장
      addDoc(commentsColRef, {
        text,
        createdAt: serverTimestamp(),
        date: dateStr,
      }).catch((err) => console.error(err));
      commentInput.value = '';
      spawnDanmaku(text);
    });
    commentInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        commentBtn.click();
      }
    });

    // 패널 열기: 카드 클릭(타이틀/이미지)로만 열고,
    // 닫기는 "바깥 클릭"에서만 처리
    const openPanel = () => {
      // 다른 카드 닫기
      document.querySelectorAll('.menu-actions').forEach((el) => {
        if (el !== actions) el.hidden = true;
      });
      actions.hidden = false;
      // 모바일에서 자동 포커스는 소프트키보드가 떠서 '클릭이 씹히는' 느낌이 자주 나서 기본은 포커스하지 않음.
      // (원하면 입력창을 직접 터치해서 포커스)
      // 데스크탑(정밀 포인터)일 때만 포커스
      const isEdge = /\bEdg\//.test(navigator.userAgent);
      if (window.matchMedia && window.matchMedia('(pointer: fine)').matches && !isEdge) {
        commentInput.focus();
      }
    };
    wrap.addEventListener('click', (ev) => {
      // 열려있을 때 메뉴 영역 클릭으로는 닫히지 않게
      if (actions.hidden) openPanel();
      ev.stopPropagation();
    });
    title.addEventListener('click', (ev) => {
      if (actions.hidden) openPanel();
      ev.stopPropagation();
    });
    actions.addEventListener('click', (ev) => {
      // 패널 내부 클릭은 닫힘 방지
      ev.stopPropagation();
    });

    document.addEventListener('click', () => {
      actions.hidden = true;
    });

    renderEmojiButtons();
    renderTitleRight();
    renderDebugPanel();

    // 공유 데이터 구독
    onSnapshot(
      restaurantDocRef,
      (snap) => {
        const d = snap.exists() ? snap.data() : {};
        const rowDate = typeof d.date === 'string' ? d.date : '';
        const savedCounts = { ...state.emojiCounts };
        const savedLive = { ...state.liveEmojiCounts };
        const savedSacrificed = { ...state.sacrificedEmojiCounts };
        const updatedMs =
          d && d.updatedAt && typeof d.updatedAt.toMillis === 'function' ? d.updatedAt.toMillis() : 0;
        if (updatedMs && lastSnapUpdatedMs && updatedMs - lastSnapUpdatedMs > 2500) {
          // 탭이 멈췄다가(백그라운드/네트워크) 한 번에 따라온 경우
          beginCatchup(1600, 2);
        }
        if (updatedMs) lastSnapUpdatedMs = updatedMs;

        if (rowDate !== dateStr) {
          state.emojiCounts = {};
          state.liveEmojiCounts = {};
          state.sacrificedEmojiCounts = {};
          state.emojiCrownMerge = {};
        } else {
          // emojiCounts는 증가만 하는 값이므로, 스냅샷이 늦게 도착해도 로컬(낙관)값이 꺾이지 않게 max로 병합
          const incCounts = d.emojiCounts || {};
          const mergedCounts = {};
          const keys = new Set([...Object.keys(incCounts), ...Object.keys(savedCounts)]);
          for (const k of keys) {
            const a = Math.floor(Number(incCounts[k]) || 0);
            const b = Math.floor(Number(savedCounts[k]) || 0);
            const v = Math.max(a, b);
            if (v > 0) mergedCounts[k] = v;
          }
          state.emojiCounts = mergedCounts;

          // liveEmojiCounts는 증감이 있으므로 서버 스냅샷을 기본으로 두고 pending delta로만 보정
          const incLive = d.liveEmojiCounts || {};
          const mergedLive = {};
          const liveKeys = new Set([...Object.keys(incLive), ...Object.keys(savedLive)]);
          for (const k of liveKeys) {
            const serverNow = Math.floor(Number(incLive[k]) || 0);
            const prevServer = Math.floor(Number(lastServerLive[k]) || 0);
            const delta = serverNow - prevServer;
            if (delta !== 0) {
              const p = pendingLiveDelta[k] || 0;
              if (p !== 0 && Math.sign(p) === Math.sign(delta)) {
                const consume = Math.min(Math.abs(p), Math.abs(delta)) * Math.sign(p);
                pendingLiveDelta[k] = p - consume;
              }
              lastServerLive[k] = serverNow;
            } else if (lastServerLive[k] === undefined) {
              lastServerLive[k] = serverNow;
            }
            const effective = Math.max(0, serverNow + (pendingLiveDelta[k] || 0));
            if (effective > 0) mergedLive[k] = effective;
          }
          state.liveEmojiCounts = mergedLive;

          const rawCm = d.emojiCrownMerge || {};
          const nextCm = {};
          for (const k of Object.keys(rawCm)) {
            let v = Math.floor(Number(rawCm[k]) || 0);
            v = Math.max(0, Math.min(CROWN_ABSORB_CAP, v));
            if (v > 0) nextCm[k] = v;
          }
          state.emojiCrownMerge = nextCm;
          const incSac = d.sacrificedEmojiCounts || {};
          const legacyDes = d.destroyedEmojiCounts || {};
          const mergedSac = {};
          const sacKeys = new Set([
            ...Object.keys(incSac),
            ...Object.keys(legacyDes),
            ...Object.keys(savedSacrificed),
          ]);
          for (const k of sacKeys) {
            const a = Math.floor(Number(incSac[k]) || 0);
            const b = Math.floor(Number(legacyDes[k]) || 0);
            const c = Math.floor(Number(savedSacrificed[k]) || 0);
            const v = Math.max(a, b, c);
            if (v > 0) mergedSac[k] = v;
          }
          state.sacrificedEmojiCounts = mergedSac;
        }

        renderTitleRight();
        syncEmojiPinballs();
        renderDebugPanel();
      },
      (err) => console.error(err),
    );

    const commentsQ = query(commentsColRef, orderBy('createdAt', 'desc'), limit(30));
    onSnapshot(
      commentsQ,
      (snap) => {
        state.comments = snap.docs
          .map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }))
          .filter((c) => c.date === dateStr)
          .filter((c) => typeof c.text === 'string' && c.text.length > 0)
          .map((c) => ({ id: c.id, text: c.text }));
      },
      (err) => console.error(err),
    );

    startDanmakuLoop();

    window.__BABB_PINBALL_CLEANUPS__.push(() => {
      stopPinballLoop();
      if (sacrificePersistTimer != null) {
        window.clearTimeout(sacrificePersistTimer);
        sacrificePersistTimer = null;
      }
      if (livePersistTimer != null) {
        window.clearTimeout(livePersistTimer);
        livePersistTimer = null;
      }
      if (mergePersistTimer != null) {
        window.clearTimeout(mergePersistTimer);
        mergePersistTimer = null;
      }
      if (Object.keys(sacrificePersistPending).length > 0) {
        flushSacrificePersistToFirestore();
      }
      if (Object.keys(livePersistPending).length > 0) {
        flushLivePersistToFirestore();
      }
      if (Object.keys(mergePersistPending).length > 0) {
        flushMergePersistToFirestore();
      }
    });
  }
}

function showData(data) {
  const dateStr = typeof data.date === 'string' ? data.date : '';
  const updatedStr = formatFirestoreTime(data.updatedAt);

  loadingEl.hidden = true;
  errorEl.hidden = true;

  let toRender = [];
  // 신규 스키마 우선
  if (Array.isArray(data.restaurants) && data.restaurants.length > 0) {
    toRender = data.restaurants.filter(
      (r) => r && typeof r.imageUrl === 'string' && r.imageUrl.length > 0,
    );
  } else if (typeof data.imageUrl === 'string' && data.imageUrl.length > 0) {
    // 구버전(단일 이미지)도 보여주기
    toRender = [{ id: 'menu', name: '오늘의 메뉴', imageUrl: data.imageUrl }];
  } else {
    showError('메뉴 데이터(restaurants/imageUrl)가 없습니다.');
    return;
  }

  renderMenus(toRender);
  showDebug(data, toRender);
  lastRenderedRestaurants = toRender;

  // 카드 렌더링에서 쓸 날짜(리셋/저장 키용)
  window.__BABB_DATE__ = dateStr || '';

  if (updatedStr) {
    updatedLine.hidden = false;
    updatedLine.textContent = `갱신일: ${updatedStr}`;
  } else {
    updatedLine.hidden = true;
  }
}

function formatDebugKeyVals(obj) {
  const keys = Object.keys(obj);
  if (keys.length === 0) return '';
  keys.sort();
  return keys.map((k) => `${k}:${obj[k]}`).join('  ');
}

const menuRef = doc(db, 'menus', 'current');

onSnapshot(
  menuRef,
  (snapshot) => {
    if (!snapshot.exists()) {
      showError('아직 등록된 메뉴가 없습니다. 봇이 한 번 실행되면 표시됩니다.');
      return;
    }
    const data = snapshot.data();
    showData(data);
  },
  (err) => {
    console.error(err);
    showError(
      'Firestore에 연결할 수 없습니다. 보안 규칙(읽기 허용)과 네트워크를 확인해 주세요.',
    );
  },
);

// 헤더: 메뉴 비교(3장 모달)
const compareBtn = document.getElementById('compare-btn');
if (compareBtn) {
  compareBtn.addEventListener('click', () => {
    if (!lastRenderedRestaurants || lastRenderedRestaurants.length === 0) return;
    openCompareModal(lastRenderedRestaurants);
  });
}
