module.exports = function (eleventyConfig) {
  eleventyConfig.ignores.add("netlify");
  eleventyConfig.ignores.add("Documentos");

  eleventyConfig.addPassthroughCopy("css");
  eleventyConfig.addPassthroughCopy("img");
  eleventyConfig.addPassthroughCopy("js");
  eleventyConfig.addPassthroughCopy("admin");

  eleventyConfig.addFilter("dia", (date) =>
    new Date(date).getUTCDate().toString().padStart(2, "0")
  );

  eleventyConfig.addFilter("mesAnio", (date) => {
    const d = new Date(date);
    const mes = d.toLocaleDateString("es-ES", { month: "short", timeZone: "UTC" }).replace(".", "");
    return `${mes.charAt(0).toUpperCase()}${mes.slice(1)} ${d.getUTCFullYear()}`;
  });

  eleventyConfig.addFilter("fechaLarga", (date) =>
    new Date(date).toLocaleDateString("es-ES", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    })
  );

  eleventyConfig.addFilter("limit", (arr, n) => (arr || []).slice(0, n));

  eleventyConfig.addFilter("basename", (p) =>
    decodeURIComponent((p || "").split("/").pop())
  );

  return {
    dir: {
      input: ".",
      output: "_site",
      includes: "_includes",
    },
    templateFormats: ["njk", "md"],
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
  };
};
