// The name of the product, from the host that serves the page: a host that
// answers to "worky" is worky, every other host is stanze. A host that names
// neither keeps the stanze title, so a new name needs no edit here.
(function () {
  var name = /^worky([.-]|$)/i.test(location.hostname) ? 'worky' : 'stanze';
  document.title = name;
  var nodes = document.querySelectorAll('.tbtitle, .lobby-title');
  for (var i = 0; i < nodes.length; i++) nodes[i].textContent = name;
})();
