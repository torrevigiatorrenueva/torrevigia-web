document.addEventListener("DOMContentLoaded", () => {
  const menuToggle = document.getElementById("menuToggle");
  const navLinks = document.getElementById("navLinks");

  if (menuToggle && navLinks) {
    menuToggle.addEventListener("click", () => {
      navLinks.classList.toggle("open");
    });

    navLinks.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => navLinks.classList.remove("open"));
    });
  }

  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  const joinForm = document.getElementById("joinForm");
  if (joinForm) {
    joinForm.addEventListener("submit", (e) => {
      e.preventDefault();
      alert("Gracias por tu interés en Torrevigia. Este formulario es una maqueta de demostración; conéctalo a un servicio de envío real para recibir solicitudes.");
      joinForm.reset();
    });
  }

  const contactForm = document.getElementById("contactForm");
  if (contactForm) {
    const status = document.getElementById("contactStatus");
    const showStatus = (color, text) => {
      if (!status) return;
      status.style.display = "block";
      status.style.color = color;
      status.textContent = text;
    };
    contactForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = contactForm.querySelector("button[type=submit]");
      if (btn) { btn.disabled = true; btn.textContent = "Enviando…"; }
      try {
        const res = await fetch("/", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(new FormData(contactForm)).toString(),
        });
        if (!res.ok) throw new Error("Error " + res.status);
        contactForm.reset();
        showStatus("#1f6b43", "¡Gracias! Hemos recibido tu mensaje y te responderemos lo antes posible.");
      } catch (err) {
        showStatus("#a12", "No se ha podido enviar el mensaje. Inténtalo de nuevo o escríbenos a torrevigia.torrenueva@gmail.com.");
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = "Enviar mensaje"; }
      }
    });
  }

});
