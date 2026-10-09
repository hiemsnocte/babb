/** Original menu image and comparison interactions, without network or game state. */
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
  let finalList = list.filter(
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

export { openImageModal, openCompareModal };
