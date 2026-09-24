'use strict';

/**
 * A deliberately tiny DOM double for testing popup.js under Node.
 *
 * It implements ONLY the surface popup.js touches (getElementById, createElement,
 * createDocumentFragment, appendChild/childNodes, textContent, className,
 * classList, dataset, hidden/value/checked/disabled, set/removeAttribute,
 * querySelectorAll, closest, addEventListener/dispatch). It is not a browser:
 * anything richer is out of scope on purpose, so the popup cannot silently start
 * depending on behaviour that the suite does not verify.
 */

function matches(element, selector) {
  if (!element) return false;
  if (selector === '[data-action]') return typeof element.dataset.action === 'string';
  if (selector === '.chip') return String(element.className).split(/\s+/).indexOf('chip') !== -1;

  const rowMatch = /^tr\[data-index\]$/.exec(selector);
  if (rowMatch) return element.tagName === 'TR' && element.dataset.index !== undefined;

  const idMatch = /^#([\w-]+)$/.exec(selector);
  if (idMatch) return element.id === idMatch[1];

  return false;
}

function collect(element, predicate, found) {
  element.childNodes.forEach((child) => {
    if (predicate(child)) found.push(child);
    collect(child, predicate, found);
  });
  return found;
}

class ClassList {
  constructor(element) {
    this.element = element;
  }

  names() {
    return String(this.element.className || '')
      .split(/\s+/)
      .filter(Boolean);
  }

  write(names) {
    this.element.className = names.join(' ');
  }

  contains(name) {
    return this.names().indexOf(name) !== -1;
  }

  add(name) {
    if (!this.contains(name)) this.write(this.names().concat(name));
  }

  remove(name) {
    this.write(this.names().filter((existing) => existing !== name));
  }

  toggle(name, force) {
    const shouldHave = force === undefined ? !this.contains(name) : Boolean(force);
    if (shouldHave) this.add(name);
    else this.remove(name);
    return shouldHave;
  }
}

class Element {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.ownerDocument = ownerDocument;
    this.childNodes = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = {};
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.text = '';
    this.listeners = {};
    this.classList = new ClassList(this);
  }

  get textContent() {
    return this.childNodes.reduce((accumulated, child) => accumulated + child.textContent, this.text);
  }

  set textContent(value) {
    this.childNodes = [];
    this.text = value === null || value === undefined ? '' : String(value);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  appendChild(child) {
    if (!child) return child;
    if (child.fragment) {
      child.childNodes.slice().forEach((nested) => this.appendChild(nested));
      child.childNodes = [];
      return child;
    }
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }

  hasChildNodes() {
    return this.childNodes.length > 0;
  }

  querySelector() {
    return null; // popup.js only uses it defensively
  }

  querySelectorAll(selector) {
    return collect(this, (element) => matches(element, selector), []);
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (matches(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  addEventListener(type, handler) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }

  /** Test helper: run the registered listeners for a type. */
  async dispatch(type, event) {
    const handlers = this.listeners[type] || [];
    for (const handler of handlers) {
      await handler(event || { type: type, target: this, preventDefault() {} });
    }
  }
}

class Fragment extends Element {
  constructor(ownerDocument) {
    super('#fragment', ownerDocument);
    this.fragment = true;
  }
}

/** Build a document that knows every id declared in the popup markup. */
function createDocument(html) {
  const document = {
    elements: Object.create(null),
    listeners: {},
    createElement: (tagName) => new Element(tagName, document),
    createDocumentFragment: () => new Fragment(document),
    addEventListener(type, handler) {
      if (!document.listeners[type]) document.listeners[type] = [];
      document.listeners[type].push(handler);
    },
    async fire(type, event) {
      const handlers = document.listeners[type] || [];
      for (const handler of handlers) {
        await handler(event || { type: type });
      }
    },
    getElementById(id) {
      if (!document.elements[id]) {
        const element = new Element('div', document);
        element.id = id;
        document.elements[id] = element;
      }
      return document.elements[id];
    }
  };

  // Register every id from the markup and carry over the attributes the popup
  // relies on for its initial state (a real parser would do this for us).
  const tagPattern = /<[a-zA-Z][\w-]*\b[^>]*>/g;
  let match = tagPattern.exec(html);
  while (match) {
    const tag = match[0];
    const idMatch = /\sid="([\w-]+)"/.exec(tag);
    if (idMatch) {
      const element = document.getElementById(idMatch[1]);
      if (/\shidden(\s|>|$)/.test(tag)) element.hidden = true;
      if (/\sdisabled(\s|>|$)/.test(tag)) element.disabled = true;
      if (/\schecked(\s|>|$)/.test(tag)) element.checked = true;
      const valueMatch = /\svalue="([^"]*)"/.exec(tag);
      if (valueMatch) element.value = valueMatch[1];
    }
    match = tagPattern.exec(html);
  }

  return document;
}

module.exports = { createDocument: createDocument, Element: Element };
