const Graph = require('../src/index_builder');

describe("integration test", function() {
    this.timeout(30000);
    it("should be able to build the graph", function() {
        return Graph.buildGraph();
    });
});
