module.exports = {
  layout: "comunicado.njk",
  tags: "comunicados",
  permalink: (data) => `comunicados/${data.page.fileSlug}.html`,
};
