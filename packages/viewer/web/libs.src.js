// Graph drawing and community detection for the page, bundled into assets/libs.js (scripts/build.mjs); no CDN at runtime.
import Graph from 'graphology';
import Sigma from 'sigma';
import louvain from 'graphology-communities-louvain';
window.LIBS = { Graph, Sigma, louvain };
