const sidebar = document.querySelector("#sidebar");
const menuButton = document.querySelector("[data-sidebar-toggle]");
const backdrop = document.querySelector("[data-sidebar-close]");

function setSidebar(open) {
  document.body.classList.toggle("sidebar-open", open);
  menuButton?.setAttribute("aria-expanded", String(open));
}

menuButton?.addEventListener("click", () => setSidebar(!document.body.classList.contains("sidebar-open")));
backdrop?.addEventListener("click", () => setSidebar(false));
document.querySelector("[data-flash-close]")?.addEventListener("click", (event) => event.currentTarget.closest(".flash")?.remove());
