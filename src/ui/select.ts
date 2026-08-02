/**
 * A themed dropdown standing in for the native `<select>`, which takes its
 * popup's colours from the OS and cannot be told otherwise — a white list
 * dropping out of a dark window reads as another app's window.
 *
 * The native element stays in the DOM as the single owner of options and
 * value: the button and listbox only *render* it, choosing writes
 * `select.value` and dispatches `change`, so form bindings never learn the
 * control moved. The options are re-read every open, which is what lets
 * `fill()` append a preset the presets don't cover and have it appear.
 *
 * Keyboard and ARIA follow the select-only combobox pattern: the button is
 * `role="combobox"` with `aria-expanded`/`aria-controls`, the popup is a
 * `listbox` of `option`s, and the active option rides
 * `aria-activedescendant` so focus never leaves the button.
 */

let seq = 0;

/** Re-renders the button from the select's current value, keyed by select. */
const registry = new WeakMap<HTMLSelectElement, () => void>();

/** After `fill()` writes `select.value`, the button has to be told. */
export function refreshSelect(select: HTMLSelectElement): void {
  registry.get(select)?.();
}

export function enhanceSelect(select: HTMLSelectElement): void {
  seq += 1;
  const listId = `sel-list-${seq}`;
  // The stylesheet hides the native control; it keeps existing for value,
  // options, form bindings and the tests that assert on the wire.
  select.dataset["enhanced"] = "true";
  select.tabIndex = -1;

  const button = document.createElement("button");
  button.type = "button";
  button.id = `${select.id}-button`;
  // The select's classes carry the sizing; `sel__button` adds the chevron.
  button.className = `sel__button ${select.className}`;
  button.setAttribute("role", "combobox");
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", listId);
  const name = select.getAttribute("aria-label");
  if (name !== null) button.setAttribute("aria-label", name);

  const popup = document.createElement("ul");
  popup.className = "sel__list";
  popup.id = listId;
  popup.setAttribute("role", "listbox");
  popup.hidden = true;

  select.after(button, popup);

  let active = 0;

  const selectedLabel = (): string =>
    select.selectedIndex >= 0 ? (select.options[select.selectedIndex]?.text ?? "") : "";

  const render = (): void => {
    button.textContent = selectedLabel();
  };
  registry.set(select, render);
  render();

  const options = (): HTMLElement[] => [...popup.querySelectorAll<HTMLElement>("[role='option']")];

  const mark = (index: number): void => {
    const all = options();
    active = Math.max(0, Math.min(index, all.length - 1));
    all.forEach((option, i) => {
      option.classList.toggle("sel__option--active", i === active);
    });
    const id = all[active]?.id;
    if (id !== undefined) button.setAttribute("aria-activedescendant", id);
    all[active]?.scrollIntoView({ block: "nearest" });
  };

  const close = (): void => {
    if (popup.hidden) return;
    popup.hidden = true;
    button.setAttribute("aria-expanded", "false");
    button.removeAttribute("aria-activedescendant");
  };

  const choose = (index: number): void => {
    const option = options()[index];
    if (option === undefined) return;
    select.value = option.dataset["value"] ?? "";
    render();
    close();
    // The same event a native change fires, so the existing binding saves.
    select.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const open = (): void => {
    popup.replaceChildren(
      ...[...select.options].map((choice, i) => {
        const item = document.createElement("li");
        item.className = "sel__option";
        item.id = `${listId}-${i}`;
        item.setAttribute("role", "option");
        item.dataset["value"] = choice.value;
        item.textContent = choice.text;
        item.setAttribute("aria-selected", String(i === select.selectedIndex));
        item.addEventListener("pointerdown", (event) => {
          // Before the document listener closes the popup under the click.
          event.preventDefault();
          choose(i);
        });
        return item;
      }),
    );
    popup.hidden = false;
    button.setAttribute("aria-expanded", "true");

    // Clamped to the window like the tooltip: the popup floats over the
    // pane, and a pane that scrolls must not clip the list mid-option.
    const anchor = button.getBoundingClientRect();
    popup.style.minWidth = `${anchor.width}px`;
    const size = popup.getBoundingClientRect();
    let top = anchor.bottom + 4;
    if (top + size.height + 8 > window.innerHeight) top = anchor.top - size.height - 4;
    popup.style.top = `${Math.max(8, top)}px`;
    popup.style.left = `${Math.min(anchor.left, window.innerWidth - size.width - 8)}px`;

    mark(Math.max(0, select.selectedIndex));
  };

  button.addEventListener("click", () => {
    if (popup.hidden) open();
    else close();
  });

  button.addEventListener("keydown", (event) => {
    if (popup.hidden) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        open();
      }
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        mark(active + 1);
        return;
      case "ArrowUp":
        event.preventDefault();
        mark(active - 1);
        return;
      case "Home":
        event.preventDefault();
        mark(0);
        return;
      case "End":
        event.preventDefault();
        mark(options().length - 1);
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        choose(active);
        return;
      case "Escape":
        // Consumed: this Escape closed a popup, and whatever the window
        // does with Escape must not also happen on the same press.
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      case "Tab":
        close();
        return;
      default: {
        // Typeahead on first letters, the way a native select answers keys.
        if (event.key.length === 1 && /\S/.test(event.key)) {
          const lower = event.key.toLowerCase();
          const hit = options().findIndex((option) =>
            option.textContent.toLowerCase().startsWith(lower),
          );
          if (hit >= 0) mark(hit);
        }
      }
    }
  });

  button.addEventListener("blur", close);
  document.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Node && !button.contains(event.target)) close();
  });
}
