/* Small inline SVG icon set, drawn in one consistent Lucide-style line weight. */
(function () {
  "use strict";

  const shapes = {
    menu: [["path", { d: "M4 6h16M4 12h16M4 18h16" }]],
    compass: [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "m16.2 7.8-3.7 8.1-4.7 2.3 2.3-4.7 6.1-5.7Z" }]],
    screen: [["rect", { x: "2.5", y: "3.5", width: "19", height: "13", rx: "2" }], ["path", { d: "M8 21h8M12 16.5V21" }]],
    userRound: [["circle", { cx: "12", cy: "8", r: "4" }], ["path", { d: "M5 21a7 7 0 0 1 14 0" }]],
    userPlus: [["path", { d: "M15 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" }], ["circle", { cx: "9", cy: "7", r: "4" }], ["path", { d: "M19 8v6m-3-3h6" }]],
    plus: [["path", { d: "M12 5v14M5 12h14" }]],
    play: [["path", { d: "m8 5 12 7-12 7z" }]],
    clapperboard: [["path", { d: "M3 8h18v13H3zM3 8l2-5h18l-2 5" }], ["path", { d: "m8 3 5 5m2-5 5 5" }]],
    search: [["circle", { cx: "11", cy: "11", r: "7" }], ["path", { d: "m20 20-4-4" }]],
    copy: [["rect", { x: "8", y: "8", width: "13", height: "13", rx: "2" }], ["path", { d: "M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" }]],
    chart: [["path", { d: "M3 3v18h18" }], ["rect", { x: "7", y: "12", width: "3", height: "6", rx: "1" }], ["rect", { x: "14", y: "7", width: "3", height: "11", rx: "1" }]],
    vote: [["path", { d: "M4 11h16v10H4zM8 6l3-3 5 5-3 3z" }], ["path", { d: "m8 16 2 2 5-5" }]],
    arrowUpRight: [["path", { d: "M7 17 17 7M8 7h9v9" }]],
    refresh: [["path", { d: "M20 7v5h-5M4 17v-5h5" }], ["path", { d: "M5.6 9A7 7 0 0 1 18 6l2 6M4 12l2 6a7 7 0 0 0 12.4-3" }]],
    film: [["rect", { x: "2", y: "3", width: "20", height: "18", rx: "2" }], ["path", { d: "M7 3v18M17 3v18M2 8h5m-5 5h5m-5 5h5m10-10h5m-5 5h5m-5 5h5" }]],
    monitorUp: [["rect", { x: "2.5", y: "3", width: "19", height: "13", rx: "2" }], ["path", { d: "M8 21h8m-4-5v5m-3-11 3-3 3 3m-3-3v6" }]],
    square: [["rect", { x: "5", y: "5", width: "14", height: "14", rx: "2" }]],
    video: [["rect", { x: "3", y: "6", width: "13", height: "12", rx: "2" }], ["path", { d: "m16 10 5-3v10l-5-3" }]],
    videoOff: [["path", { d: "m3 3 18 18M10.6 6H14a2 2 0 0 1 2 2v1l5-3v10l-2-1.2M16 15v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8c0-.7.4-1.4 1-1.7" }]],
    mic: [["rect", { x: "9", y: "2", width: "6", height: "12", rx: "3" }], ["path", { d: "M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-4 0h8" }]],
    micOff: [["path", { d: "m3 3 18 18M9 9v3a3 3 0 0 0 5.1 2.1M15 9V5a3 3 0 0 0-5.8-1M5 10v2a7 7 0 0 0 11.9 5M19 10v2m-7 7v3m-4 0h8" }]],
    camera: [["rect", { x: "3", y: "6", width: "13", height: "12", rx: "2" }], ["path", { d: "m16 10 5-3v10l-5-3" }]],
    cameraOff: [["path", { d: "m3 3 18 18M16 10l5-3v10l-3-1.8M10.6 6H14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8c0-.7.4-1.4 1-1.7" }]],
    volume2: [["path", { d: "M11 5 6 9H3v6h3l5 4z" }], ["path", { d: "M15.5 8.5a5 5 0 0 1 0 7m3-10a9 9 0 0 1 0 13" }]],
    volumeX: [["path", { d: "M11 5 6 9H3v6h3l5 4z" }], ["path", { d: "m16 9 5 6m0-6-5 6" }]],
    messages: [["path", { d: "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z" }]],
    smile: [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" }]],
    send: [["path", { d: "m22 2-7 20-4-9-9-4Z" }], ["path", { d: "M22 2 11 13" }]],
    close: [["path", { d: "m18 6-12 12M6 6l12 12" }]],
    check: [["path", { d: "m5 12 4 4L19 6" }]],
    chevronDown: [["path", { d: "m6 9 6 6 6-6" }]],
    maximize: [["path", { d: "M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3" }]],
  };

  function create(name, size, className) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(size || 16));
    svg.setAttribute("height", String(size || 16));
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.classList.add(className || "ui-icon");
    (shapes[name] || shapes.film).forEach(function (shape) {
      const node = document.createElementNS("http://www.w3.org/2000/svg", shape[0]);
      Object.entries(shape[1]).forEach(function (entry) { node.setAttribute(entry[0], entry[1]); });
      svg.append(node);
    });
    return svg;
  }

  function hydrate(root) {
    (root || document).querySelectorAll("[data-icon]").forEach(function (element) {
      if (!element.querySelector("svg")) element.replaceChildren(create(element.dataset.icon, Number(element.dataset.iconSize) || 16));
    });
  }

  window.AfterglowIcons = { create: create, hydrate: hydrate };
  hydrate(document);
})();
