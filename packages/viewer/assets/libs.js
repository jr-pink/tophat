(()=>{var zo=Object.create;var Wa=Object.defineProperty;var Wo=Object.getOwnPropertyDescriptor;var Bo=Object.getOwnPropertyNames;var Uo=Object.getPrototypeOf,Oo=Object.prototype.hasOwnProperty;var pe=(n,a)=>()=>(a||n((a={exports:{}}).exports,a),a.exports);var Ho=(n,a,t,e)=>{if(a&&typeof a=="object"||typeof a=="function")for(let r of Bo(a))!Oo.call(n,r)&&r!==t&&Wa(n,r,{get:()=>a[r],enumerable:!(e=Wo(a,r))||e.enumerable});return n};var Ve=(n,a,t)=>(t=n!=null?zo(Uo(n)):{},Ho(a||!n||!n.__esModule?Wa(t,"default",{value:n,enumerable:!0}):t,n));var Dt=pe((Yh,On)=>{"use strict";var at=typeof Reflect=="object"?Reflect:null,Ba=at&&typeof at.apply=="function"?at.apply:function(a,t,e){return Function.prototype.apply.call(a,t,e)},qt;at&&typeof at.ownKeys=="function"?qt=at.ownKeys:Object.getOwnPropertySymbols?qt=function(a){return Object.getOwnPropertyNames(a).concat(Object.getOwnPropertySymbols(a))}:qt=function(a){return Object.getOwnPropertyNames(a)};function $o(n){console&&console.warn&&console.warn(n)}var Oa=Number.isNaN||function(a){return a!==a};function J(){J.init.call(this)}On.exports=J;On.exports.once=qo;J.EventEmitter=J;J.prototype._events=void 0;J.prototype._eventsCount=0;J.prototype._maxListeners=void 0;var Ua=10;function Yt(n){if(typeof n!="function")throw new TypeError('The "listener" argument must be of type Function. Received type '+typeof n)}Object.defineProperty(J,"defaultMaxListeners",{enumerable:!0,get:function(){return Ua},set:function(n){if(typeof n!="number"||n<0||Oa(n))throw new RangeError('The value of "defaultMaxListeners" is out of range. It must be a non-negative number. Received '+n+".");Ua=n}});J.init=function(){(this._events===void 0||this._events===Object.getPrototypeOf(this)._events)&&(this._events=Object.create(null),this._eventsCount=0),this._maxListeners=this._maxListeners||void 0};J.prototype.setMaxListeners=function(a){if(typeof a!="number"||a<0||Oa(a))throw new RangeError('The value of "n" is out of range. It must be a non-negative number. Received '+a+".");return this._maxListeners=a,this};function Ha(n){return n._maxListeners===void 0?J.defaultMaxListeners:n._maxListeners}J.prototype.getMaxListeners=function(){return Ha(this)};J.prototype.emit=function(a){for(var t=[],e=1;e<arguments.length;e++)t.push(arguments[e]);var r=a==="error",i=this._events;if(i!==void 0)r=r&&i.error===void 0;else if(!r)return!1;if(r){var o;if(t.length>0&&(o=t[0]),o instanceof Error)throw o;var s=new Error("Unhandled error."+(o?" ("+o.message+")":""));throw s.context=o,s}var l=i[a];if(l===void 0)return!1;if(typeof l=="function")Ba(l,this,t);else for(var u=l.length,d=qa(l,u),e=0;e<u;++e)Ba(d[e],this,t);return!0};function $a(n,a,t,e){var r,i,o;if(Yt(t),i=n._events,i===void 0?(i=n._events=Object.create(null),n._eventsCount=0):(i.newListener!==void 0&&(n.emit("newListener",a,t.listener?t.listener:t),i=n._events),o=i[a]),o===void 0)o=i[a]=t,++n._eventsCount;else if(typeof o=="function"?o=i[a]=e?[t,o]:[o,t]:e?o.unshift(t):o.push(t),r=Ha(n),r>0&&o.length>r&&!o.warned){o.warned=!0;var s=new Error("Possible EventEmitter memory leak detected. "+o.length+" "+String(a)+" listeners added. Use emitter.setMaxListeners() to increase limit");s.name="MaxListenersExceededWarning",s.emitter=n,s.type=a,s.count=o.length,$o(s)}return n}J.prototype.addListener=function(a,t){return $a(this,a,t,!1)};J.prototype.on=J.prototype.addListener;J.prototype.prependListener=function(a,t){return $a(this,a,t,!0)};function Vo(){if(!this.fired)return this.target.removeListener(this.type,this.wrapFn),this.fired=!0,arguments.length===0?this.listener.call(this.target):this.listener.apply(this.target,arguments)}function Va(n,a,t){var e={fired:!1,wrapFn:void 0,target:n,type:a,listener:t},r=Vo.bind(e);return r.listener=t,e.wrapFn=r,r}J.prototype.once=function(a,t){return Yt(t),this.on(a,Va(this,a,t)),this};J.prototype.prependOnceListener=function(a,t){return Yt(t),this.prependListener(a,Va(this,a,t)),this};J.prototype.removeListener=function(a,t){var e,r,i,o,s;if(Yt(t),r=this._events,r===void 0)return this;if(e=r[a],e===void 0)return this;if(e===t||e.listener===t)--this._eventsCount===0?this._events=Object.create(null):(delete r[a],r.removeListener&&this.emit("removeListener",a,e.listener||t));else if(typeof e!="function"){for(i=-1,o=e.length-1;o>=0;o--)if(e[o]===t||e[o].listener===t){s=e[o].listener,i=o;break}if(i<0)return this;i===0?e.shift():jo(e,i),e.length===1&&(r[a]=e[0]),r.removeListener!==void 0&&this.emit("removeListener",a,s||t)}return this};J.prototype.off=J.prototype.removeListener;J.prototype.removeAllListeners=function(a){var t,e,r;if(e=this._events,e===void 0)return this;if(e.removeListener===void 0)return arguments.length===0?(this._events=Object.create(null),this._eventsCount=0):e[a]!==void 0&&(--this._eventsCount===0?this._events=Object.create(null):delete e[a]),this;if(arguments.length===0){var i=Object.keys(e),o;for(r=0;r<i.length;++r)o=i[r],o!=="removeListener"&&this.removeAllListeners(o);return this.removeAllListeners("removeListener"),this._events=Object.create(null),this._eventsCount=0,this}if(t=e[a],typeof t=="function")this.removeListener(a,t);else if(t!==void 0)for(r=t.length-1;r>=0;r--)this.removeListener(a,t[r]);return this};function ja(n,a,t){var e=n._events;if(e===void 0)return[];var r=e[a];return r===void 0?[]:typeof r=="function"?t?[r.listener||r]:[r]:t?Xo(r):qa(r,r.length)}J.prototype.listeners=function(a){return ja(this,a,!0)};J.prototype.rawListeners=function(a){return ja(this,a,!1)};J.listenerCount=function(n,a){return typeof n.listenerCount=="function"?n.listenerCount(a):Xa.call(n,a)};J.prototype.listenerCount=Xa;function Xa(n){var a=this._events;if(a!==void 0){var t=a[n];if(typeof t=="function")return 1;if(t!==void 0)return t.length}return 0}J.prototype.eventNames=function(){return this._eventsCount>0?qt(this._events):[]};function qa(n,a){for(var t=new Array(a),e=0;e<a;++e)t[e]=n[e];return t}function jo(n,a){for(;a+1<n.length;a++)n[a]=n[a+1];n.pop()}function Xo(n){for(var a=new Array(n.length),t=0;t<a.length;++t)a[t]=n[t].listener||n[t];return a}function qo(n,a){return new Promise(function(t,e){function r(o){n.removeListener(a,i),e(o)}function i(){typeof n.removeListener=="function"&&n.removeListener("error",r),t([].slice.call(arguments))}Ya(n,a,i,{once:!0}),a!=="error"&&Yo(n,r,{once:!0})})}function Yo(n,a,t){typeof n.on=="function"&&Ya(n,"error",a,t)}function Ya(n,a,t,e){if(typeof n.on=="function")e.once?n.once(a,t):n.on(a,t);else if(typeof n.addEventListener=="function")n.addEventListener(a,function r(i){e.once&&n.removeEventListener(a,r),t(i)});else throw new TypeError('The "emitter" argument must be of type EventEmitter. Received type '+typeof n)}});var It=pe((uc,Or)=>{Or.exports=function(a){return a!==null&&typeof a=="object"&&typeof a.addUndirectedEdgeWithKey=="function"&&typeof a.dropNode=="function"&&typeof a.multi=="boolean"}});var Fa=pe((jc,ro)=>{function wh(n){return!n||typeof n!="object"||typeof n=="function"||Array.isArray(n)||n instanceof Set||n instanceof Map||n instanceof RegExp||n instanceof Date}function ao(n,a){n=n||{};var t={};for(var e in a){var r=n[e],i=a[e];if(!wh(i)){t[e]=ao(r,i);continue}r===void 0?t[e]=i:t[e]=r}return t}ro.exports=ao});var oo=pe((Xc,io)=>{var Dh=It();io.exports=function(a){if(!Dh(a))throw new Error("graphology-utils/infer-type: expecting a valid graphology instance.");var t=a.type;return t!=="mixed"?t:a.directedSize===0&&a.undirectedSize===0||a.directedSize>0&&a.undirectedSize>0?"mixed":a.directedSize>0?"directed":"undirected"}});var Ia=pe((qc,so)=>{function Re(n){if(typeof n!="function")throw new Error("obliterator/iterator: expecting a function!");this.next=n}typeof Symbol<"u"&&(Re.prototype[Symbol.iterator]=function(){return this});Re.of=function(){var n=arguments,a=n.length,t=0;return new Re(function(){return t>=a?{done:!0}:{done:!1,value:n[t++]}})};Re.empty=function(){var n=new Re(function(){return{done:!0}});return n};Re.fromSequence=function(n){var a=0,t=n.length;return new Re(function(){return a>=t?{done:!0}:{done:!1,value:n[a++]}})};Re.is=function(n){return n instanceof Re?!0:typeof n=="object"&&n!==null&&typeof n.next=="function"};so.exports=Re});var Mn=pe(Ce=>{var Rh=Math.pow(2,8)-1,Ch=Math.pow(2,16)-1,Lh=Math.pow(2,32)-1,kh=Math.pow(2,7)-1,Ph=Math.pow(2,15)-1,Fh=Math.pow(2,31)-1;Ce.getPointerArray=function(n){var a=n-1;if(a<=Rh)return Uint8Array;if(a<=Ch)return Uint16Array;if(a<=Lh)return Uint32Array;throw new Error("mnemonist: Pointer Array of size > 4294967295 is not supported.")};Ce.getSignedPointerArray=function(n){var a=n-1;return a<=kh?Int8Array:a<=Ph?Int16Array:a<=Fh?Int32Array:Float64Array};Ce.getNumberType=function(n){return n===(n|0)?Math.sign(n)===-1?n<=127&&n>=-128?Int8Array:n<=32767&&n>=-32768?Int16Array:Int32Array:n<=255?Uint8Array:n<=65535?Uint16Array:Uint32Array:Float64Array};var Ih={Uint8Array:1,Int8Array:2,Uint16Array:3,Int16Array:4,Uint32Array:5,Int32Array:6,Float32Array:7,Float64Array:8};Ce.getMinimalRepresentation=function(n,a){var t=null,e=0,r,i,o,s,l;for(s=0,l=n.length;s<l;s++)o=a?a(n[s]):n[s],i=Ce.getNumberType(o),r=Ih[i.name],r>e&&(e=r,t=i);return t};Ce.isTypedArray=function(n){return typeof ArrayBuffer<"u"&&ArrayBuffer.isView(n)};Ce.concat=function(){var n=0,a,t,e;for(a=0,e=arguments.length;a<e;a++)n+=arguments[a].length;var r=new arguments[0].constructor(n);for(a=0,t=0;a<e;a++)r.set(arguments[a],t),t+=arguments[a].length;return r};Ce.indices=function(n){for(var a=Ce.getPointerArray(n),t=new a(n),e=0;e<n;e++)t[e]=e;return t}});var uo=pe((Kc,lo)=>{var Na=Ia(),Nh=Mn().getPointerArray;function de(n,a){arguments.length<2&&(a=n,n=Array);var t=Nh(a);this.size=0,this.length=a,this.dense=new t(a),this.sparse=new t(a),this.vals=new n(a)}de.prototype.clear=function(){this.size=0};de.prototype.has=function(n){var a=this.sparse[n];return a<this.size&&this.dense[a]===n};de.prototype.get=function(n){var a=this.sparse[n];if(a<this.size&&this.dense[a]===n)return this.vals[a]};de.prototype.set=function(n,a){var t=this.sparse[n];return t<this.size&&this.dense[t]===n?(this.vals[t]=a,this):(this.dense[this.size]=n,this.sparse[n]=this.size,this.vals[this.size]=a,this.size++,this)};de.prototype.delete=function(n){var a=this.sparse[n];return a>=this.size||this.dense[a]!==n?!1:(a=this.dense[this.size-1],this.dense[this.sparse[n]]=a,this.sparse[a]=this.sparse[n],this.size--,!0)};de.prototype.forEach=function(n,a){a=arguments.length>1?a:this;for(var t=0;t<this.size;t++)n.call(a,this.vals[t],this.dense[t])};de.prototype.keys=function(){var n=this.size,a=this.dense,t=0;return new Na(function(){if(t<n){var e=a[t];return t++,{value:e}}return{done:!0}})};de.prototype.values=function(){var n=this.size,a=this.vals,t=0;return new Na(function(){if(t<n){var e=a[t];return t++,{value:e}}return{done:!0}})};de.prototype.entries=function(){var n=this.size,a=this.dense,t=this.vals,e=0;return new Na(function(){if(e<n){var r=[a[e],t[e]];return e++,{value:r}}return{done:!0}})};typeof Symbol<"u"&&(de.prototype[Symbol.iterator]=de.prototype.entries);de.prototype.inspect=function(){for(var n=new Map,a=0;a<this.size;a++)n.set(this.dense[a],this.vals[a]);return Object.defineProperty(n,"constructor",{value:de,enumerable:!1}),n.length=this.length,this.vals.constructor!==Array&&(n.type=this.vals.constructor.name),n};typeof Symbol<"u"&&(de.prototype[Symbol.for("nodejs.util.inspect.custom")]=de.prototype.inspect);lo.exports=de});var co=pe((Zc,ho)=>{var Gh=Ia(),Mh=Mn().getPointerArray;function ve(n){var a=Mh(n);this.start=0,this.size=0,this.capacity=n,this.dense=new a(n),this.sparse=new a(n)}ve.prototype.clear=function(){this.start=0,this.size=0};ve.prototype.has=function(n){if(this.size===0)return!1;var a=this.sparse[n],t=a<this.capacity&&a>=this.start&&a<this.start+this.size||a<(this.start+this.size)%this.capacity;return t&&this.dense[a]===n};ve.prototype.enqueue=function(n){var a=this.sparse[n];if(this.size!==0){var t=a<this.capacity&&a>=this.start&&a<this.start+this.size||a<(this.start+this.size)%this.capacity;if(t&&this.dense[a]===n)return this}return a=(this.start+this.size)%this.capacity,this.dense[a]=n,this.sparse[n]=a,this.size++,this};ve.prototype.dequeue=function(){if(this.size!==0){var n=this.start;this.size--,this.start++,this.start===this.capacity&&(this.start=0);var a=this.dense[n];return this.sparse[a]=this.capacity,a}};ve.prototype.forEach=function(n,a){a=arguments.length>1?a:this;for(var t=this.capacity,e=this.size,r=this.start,i=0;i<e;)n.call(a,this.dense[r],i,this),r++,i++,r===t&&(r=0)};ve.prototype.values=function(){var n=this.dense,a=this.capacity,t=this.size,e=this.start,r=0;return new Gh(function(){if(r>=t)return{done:!0};var i=n[e];return e++,r++,e===a&&(e=0),{value:i,done:!1}})};typeof Symbol<"u"&&(ve.prototype[Symbol.iterator]=ve.prototype.values);ve.prototype.inspect=function(){var n=[];return this.forEach(function(a){n.push(a)}),Object.defineProperty(n,"constructor",{value:ve,enumerable:!1}),n.capacity=this.capacity,n};typeof Symbol<"u"&&(ve.prototype[Symbol.for("nodejs.util.inspect.custom")]=ve.prototype.inspect);ho.exports=ve});var po=pe((Qc,vo)=>{function fo(n){return function(a){return typeof a!="number"&&(a=a.length),Math.floor(n()*a)}}var go=fo(Math.random);go.createRandomIndex=fo;vo.exports=go});var yo=pe(zn=>{function zh(n){return typeof n!="number"||isNaN(n)?1:n}function Wh(n,a){var t={},e=function(o){return typeof o>"u"?a:o};typeof a=="function"&&(e=a);var r=function(o){return e(o[n])},i=function(){return e(void 0)};return typeof n=="string"?(t.fromAttributes=r,t.fromGraph=function(o,s){return r(o.getNodeAttributes(s))},t.fromEntry=function(o,s){return r(s)}):typeof n=="function"?(t.fromAttributes=function(){throw new Error("graphology-utils/getters/createNodeValueGetter: irrelevant usage.")},t.fromGraph=function(o,s){return e(n(s,o.getNodeAttributes(s)))},t.fromEntry=function(o,s){return e(n(o,s))}):(t.fromAttributes=i,t.fromGraph=i,t.fromEntry=i),t}function mo(n,a){var t={},e=function(o){return typeof o>"u"?a:o};typeof a=="function"&&(e=a);var r=function(o){return e(o[n])},i=function(){return e(void 0)};return typeof n=="string"?(t.fromAttributes=r,t.fromGraph=function(o,s){return r(o.getEdgeAttributes(s))},t.fromEntry=function(o,s){return r(s)},t.fromPartialEntry=t.fromEntry,t.fromMinimalEntry=t.fromEntry):typeof n=="function"?(t.fromAttributes=function(){throw new Error("graphology-utils/getters/createEdgeValueGetter: irrelevant usage.")},t.fromGraph=function(o,s){var l=o.extremities(s);return e(n(s,o.getEdgeAttributes(s),l[0],l[1],o.getNodeAttributes(l[0]),o.getNodeAttributes(l[1]),o.isUndirected(s)))},t.fromEntry=function(o,s,l,u,d,h,c){return e(n(o,s,l,u,d,h,c))},t.fromPartialEntry=function(o,s,l,u){return e(n(o,s,l,u))},t.fromMinimalEntry=function(o,s){return e(n(o,s))}):(t.fromAttributes=i,t.fromGraph=i,t.fromEntry=i,t.fromMinimalEntry=i),t}zn.createNodeValueGetter=Wh;zn.createEdgeValueGetter=mo;zn.createEdgeWeightGetter=function(n){return mo(n,zh)}});var Eo=pe(Ga=>{var He=Mn(),bo=Fa(),xo=yo().createEdgeWeightGetter,_o=Symbol.for("nodejs.util.inspect.custom"),To={getEdgeWeight:"weight",keepDendrogram:!1,resolution:1};function ae(n,a){a=bo(a,To);var t=a.resolution,e=xo(a.getEdgeWeight).fromEntry,r=(n.size-n.selfLoopCount)*2,i=He.getPointerArray(r),o=He.getPointerArray(n.order+1),s=a.getEdgeWeight?Float64Array:He.getPointerArray(n.size*2);this.C=n.order,this.M=0,this.E=r,this.U=0,this.resolution=t,this.level=0,this.graph=n,this.nodes=new Array(n.order),this.keepDendrogram=a.keepDendrogram,this.neighborhood=new o(r),this.weights=new s(r),this.loops=new s(n.order),this.starts=new i(n.order+1),this.belongings=new o(n.order),this.dendrogram=[],this.mapping=null,this.counts=new o(n.order),this.unused=new o(n.order),this.totalWeights=new s(n.order);var l={},u,d=0,h=0,c=this;n.forEachNode(function(f){c.nodes[d]=f,l[f]=d,h+=n.undirectedDegreeWithoutSelfLoops(f),c.starts[d]=h,c.belongings[d]=d,c.counts[d]=1,d++}),n.forEachEdge(function(f,g,m,p,v,y,b){if(u=e(f,g,m,p,v,y,b),m=l[m],p=l[p],c.M+=u,m===p)c.totalWeights[m]+=u*2,c.loops[m]=u*2;else{c.totalWeights[m]+=u,c.totalWeights[p]+=u;var T=--c.starts[m],x=--c.starts[p];c.neighborhood[T]=p,c.neighborhood[x]=m,c.weights[T]=u,c.weights[x]=u}}),this.starts[d]=this.E,this.keepDendrogram?this.dendrogram.push(this.belongings.slice()):this.mapping=this.belongings.slice()}ae.prototype.isolate=function(n,a){var t=this.belongings[n];if(this.counts[t]===1)return t;var e=this.unused[--this.U],r=this.loops[n];return this.totalWeights[t]-=a+r,this.totalWeights[e]+=a+r,this.belongings[n]=e,this.counts[t]--,this.counts[e]++,e};ae.prototype.move=function(n,a,t){var e=this.belongings[n],r=this.loops[n];this.totalWeights[e]-=a+r,this.totalWeights[t]+=a+r,this.belongings[n]=t;var i=this.counts[e]--===1;this.counts[t]++,i&&(this.unused[this.U++]=e)};ae.prototype.computeNodeDegree=function(n){var a,t,e,r=0;for(a=this.starts[n],t=this.starts[n+1];a<t;a++)e=this.weights[a],r+=e;return r};ae.prototype.expensiveIsolate=function(n){var a=this.computeNodeDegree(n);return this.isolate(n,a)};ae.prototype.expensiveMove=function(n,a){var t=this.computeNodeDegree(n);this.move(n,t,a)};ae.prototype.zoomOut=function(){var n=new Array(this.C-this.U),a={},t=this.nodes.length,e=0,r=0,i,o,s,l,u,d,h,c,f;for(i=0,s=this.C;i<s;i++)d=this.belongings[i],d in a||(a[d]=e,n[e]={adj:{},totalWeights:this.totalWeights[d],internalWeights:0},e++),this.belongings[i]=a[d];var g,m;if(this.keepDendrogram){for(g=this.dendrogram[this.level],m=new(He.getPointerArray(e))(t),i=0;i<t;i++)m[i]=this.belongings[g[i]];this.dendrogram.push(m)}else for(i=0;i<t;i++)this.mapping[i]=this.belongings[this.mapping[i]];for(i=0,s=this.C;i<s;i++)for(d=this.belongings[i],c=n[d],f=c.adj,c.internalWeights+=this.loops[i],o=this.starts[i],l=this.starts[i+1];o<l;o++){if(u=this.neighborhood[o],h=this.belongings[u],d===h){c.internalWeights+=this.weights[o];continue}h in f||(f[h]=0),f[h]+=this.weights[o]}for(this.C=e,u=0,d=0;d<e;d++){c=n[d],f=c.adj,d=+d,this.totalWeights[d]=c.totalWeights,this.loops[d]=c.internalWeights,this.counts[d]=1,this.starts[d]=u,this.belongings[d]=d;for(h in f)this.neighborhood[u]=+h,this.weights[u]=f[h],r++,u++}return this.starts[e]=r,this.E=r,this.U=0,this.level++,a};ae.prototype.modularity=function(){var n,a,t,e,r,i=0,o=this.M*2,s=new Float64Array(this.C);for(t=0;t<this.C;t++)for(n=this.belongings[t],s[n]+=this.loops[t],e=this.starts[t],r=this.starts[t+1];e<r;e++)a=this.belongings[this.neighborhood[e]],n===a&&(s[n]+=this.weights[e]);for(t=0;t<this.C;t++)i+=s[t]/o-Math.pow(this.totalWeights[t]/o,2)*this.resolution;return i};ae.prototype.delta=function(n,a,t,e){var r=this.M,i=this.totalWeights[e];return a+=this.loops[n],t/r-i*a*this.resolution/(2*r*r)};ae.prototype.deltaWithOwnCommunity=function(n,a,t,e){var r=this.M,i=this.totalWeights[e];return a+=this.loops[n],t/r-(i-a)*a*this.resolution/(2*r*r)};ae.prototype.fastDelta=function(n,a,t,e){var r=this.M,i=this.totalWeights[e];return a+=this.loops[n],t-a*i*this.resolution/(2*r)};ae.prototype.fastDeltaWithOwnCommunity=function(n,a,t,e){var r=this.M,i=this.totalWeights[e];return a+=this.loops[n],t-a*(i-a)*this.resolution/(2*r)};ae.prototype.bounds=function(n){return[this.starts[n],this.starts[n+1]]};ae.prototype.project=function(){var n=this,a={};return n.nodes.slice(0,this.C).forEach(function(t,e){a[t]=Array.from(n.neighborhood.slice(n.starts[e],n.starts[e+1])).map(function(r){return n.nodes[r]})}),a};ae.prototype.collect=function(n){arguments.length<1&&(n=this.level);var a={},t=this.keepDendrogram?this.dendrogram[n]:this.mapping,e,r;for(e=0,r=t.length;e<r;e++)a[this.nodes[e]]=t[e];return a};ae.prototype.assign=function(n,a){arguments.length<2&&(a=this.level);var t=this.keepDendrogram?this.dendrogram[a]:this.mapping,e,r;for(e=0,r=t.length;e<r;e++)this.graph.setNodeAttribute(this.nodes[e],n,t[e])};ae.prototype[_o]=function(){var n={};Object.defineProperty(n,"constructor",{value:ae,enumerable:!1}),n.C=this.C,n.M=this.M,n.E=this.E,n.U=this.U,n.resolution=this.resolution,n.level=this.level,n.nodes=this.nodes,n.starts=this.starts.slice(0,n.C+1);var a=["neighborhood","weights"],t=["counts","loops","belongings","totalWeights"],e=this;return a.forEach(function(r){n[r]=e[r].slice(0,n.E)}),t.forEach(function(r){n[r]=e[r].slice(0,n.C)}),n.unused=this.unused.slice(0,this.U),this.keepDendrogram?n.dendrogram=this.dendrogram:n.mapping=this.mapping,n};function ie(n,a){a=bo(a,To);var t=a.resolution,e=xo(a.getEdgeWeight).fromEntry,r=(n.size-n.selfLoopCount)*2,i=He.getPointerArray(r),o=He.getPointerArray(n.order+1),s=a.getEdgeWeight?Float64Array:He.getPointerArray(n.size*2);this.C=n.order,this.M=0,this.E=r,this.U=0,this.resolution=t,this.level=0,this.graph=n,this.nodes=new Array(n.order),this.keepDendrogram=a.keepDendrogram,this.neighborhood=new o(r),this.weights=new s(r),this.loops=new s(n.order),this.starts=new i(n.order+1),this.offsets=new i(n.order),this.belongings=new o(n.order),this.dendrogram=[],this.counts=new o(n.order),this.unused=new o(n.order),this.totalInWeights=new s(n.order),this.totalOutWeights=new s(n.order);var l={},u,d=0,h=0,c=this;n.forEachNode(function(f){c.nodes[d]=f,l[f]=d,h+=n.outDegreeWithoutSelfLoops(f),c.starts[d]=h,h+=n.inDegreeWithoutSelfLoops(f),c.offsets[d]=h,c.belongings[d]=d,c.counts[d]=1,d++}),n.forEachEdge(function(f,g,m,p,v,y,b){if(u=e(f,g,m,p,v,y,b),m=l[m],p=l[p],c.M+=u,m===p)c.loops[m]+=u,c.totalInWeights[m]+=u,c.totalOutWeights[m]+=u;else{c.totalOutWeights[m]+=u,c.totalInWeights[p]+=u;var T=--c.starts[m],x=--c.offsets[p];c.neighborhood[T]=p,c.neighborhood[x]=m,c.weights[T]=u,c.weights[x]=u}}),this.starts[d]=this.E,this.keepDendrogram?this.dendrogram.push(this.belongings.slice()):this.mapping=this.belongings.slice()}ie.prototype.bounds=ae.prototype.bounds;ie.prototype.inBounds=function(n){return[this.offsets[n],this.starts[n+1]]};ie.prototype.outBounds=function(n){return[this.starts[n],this.offsets[n]]};ie.prototype.project=ae.prototype.project;ie.prototype.projectIn=function(){var n=this,a={};return n.nodes.slice(0,this.C).forEach(function(t,e){a[t]=Array.from(n.neighborhood.slice(n.offsets[e],n.starts[e+1])).map(function(r){return n.nodes[r]})}),a};ie.prototype.projectOut=function(){var n=this,a={};return n.nodes.slice(0,this.C).forEach(function(t,e){a[t]=Array.from(n.neighborhood.slice(n.starts[e],n.offsets[e])).map(function(r){return n.nodes[r]})}),a};ie.prototype.isolate=function(n,a,t){var e=this.belongings[n];if(this.counts[e]===1)return e;var r=this.unused[--this.U],i=this.loops[n];return this.totalInWeights[e]-=a+i,this.totalInWeights[r]+=a+i,this.totalOutWeights[e]-=t+i,this.totalOutWeights[r]+=t+i,this.belongings[n]=r,this.counts[e]--,this.counts[r]++,r};ie.prototype.move=function(n,a,t,e){var r=this.belongings[n],i=this.loops[n];this.totalInWeights[r]-=a+i,this.totalInWeights[e]+=a+i,this.totalOutWeights[r]-=t+i,this.totalOutWeights[e]+=t+i,this.belongings[n]=e;var o=this.counts[r]--===1;this.counts[e]++,o&&(this.unused[this.U++]=r)};ie.prototype.computeNodeInDegree=function(n){var a,t,e,r=0;for(a=this.offsets[n],t=this.starts[n+1];a<t;a++)e=this.weights[a],r+=e;return r};ie.prototype.computeNodeOutDegree=function(n){var a,t,e,r=0;for(a=this.starts[n],t=this.offsets[n];a<t;a++)e=this.weights[a],r+=e;return r};ie.prototype.expensiveMove=function(n,a){var t=this.computeNodeInDegree(n),e=this.computeNodeOutDegree(n);this.move(n,t,e,a)};ie.prototype.zoomOut=function(){var n=new Array(this.C-this.U),a={},t=this.nodes.length,e=0,r=0,i,o,s,l,u,d,h,c,f,g,m,p,v;for(i=0,s=this.C;i<s;i++)d=this.belongings[i],d in a||(a[d]=e,n[e]={inAdj:{},outAdj:{},totalInWeights:this.totalInWeights[d],totalOutWeights:this.totalOutWeights[d],internalWeights:0},e++),this.belongings[i]=a[d];var y,b;if(this.keepDendrogram){for(y=this.dendrogram[this.level],b=new(He.getPointerArray(e))(t),i=0;i<t;i++)b[i]=this.belongings[y[i]];this.dendrogram.push(b)}else for(i=0;i<t;i++)this.mapping[i]=this.belongings[this.mapping[i]];for(i=0,s=this.C;i<s;i++)for(d=this.belongings[i],f=this.offsets[i],c=n[d],p=c.inAdj,v=c.outAdj,c.internalWeights+=this.loops[i],o=this.starts[i],l=this.starts[i+1];o<l;o++){if(u=this.neighborhood[o],h=this.belongings[u],g=o<f,m=g?v:p,d===h){g&&(c.internalWeights+=this.weights[o]);continue}h in m||(m[h]=0),m[h]+=this.weights[o]}for(this.C=e,u=0,d=0;d<e;d++){c=n[d],p=c.inAdj,v=c.outAdj,d=+d,this.totalInWeights[d]=c.totalInWeights,this.totalOutWeights[d]=c.totalOutWeights,this.loops[d]=c.internalWeights,this.counts[d]=1,this.starts[d]=u,this.belongings[d]=d;for(h in v)this.neighborhood[u]=+h,this.weights[u]=v[h],r++,u++;this.offsets[d]=u;for(h in p)this.neighborhood[u]=+h,this.weights[u]=p[h],r++,u++}return this.starts[e]=r,this.E=r,this.U=0,this.level++,a};ie.prototype.modularity=function(){var n,a,t,e,r,i=0,o=this.M,s=new Float64Array(this.C);for(t=0;t<this.C;t++)for(n=this.belongings[t],s[n]+=this.loops[t],e=this.starts[t],r=this.offsets[t];e<r;e++)a=this.belongings[this.neighborhood[e]],n===a&&(s[n]+=this.weights[e]);for(t=0;t<this.C;t++)i+=s[t]/o-this.totalInWeights[t]*this.totalOutWeights[t]/Math.pow(o,2)*this.resolution;return i};ie.prototype.delta=function(n,a,t,e,r){var i=this.M,o=this.totalInWeights[r],s=this.totalOutWeights[r],l=this.loops[n];return a+=l,t+=l,e/i-(t*o+a*s)*this.resolution/(i*i)};ie.prototype.deltaWithOwnCommunity=function(n,a,t,e,r){var i=this.M,o=this.totalInWeights[r],s=this.totalOutWeights[r],l=this.loops[n];return a+=l,t+=l,e/i-(t*(o-a)+a*(s-t))*this.resolution/(i*i)};ie.prototype.collect=ae.prototype.collect;ie.prototype.assign=ae.prototype.assign;ie.prototype[_o]=function(){var n={};Object.defineProperty(n,"constructor",{value:ie,enumerable:!1}),n.C=this.C,n.M=this.M,n.E=this.E,n.U=this.U,n.resolution=this.resolution,n.level=this.level,n.nodes=this.nodes,n.starts=this.starts.slice(0,n.C+1);var a=["neighborhood","weights"],t=["counts","offsets","loops","belongings","totalInWeights","totalOutWeights"],e=this;return a.forEach(function(r){n[r]=e[r].slice(0,n.E)}),t.forEach(function(r){n[r]=e[r].slice(0,n.C)}),n.unused=this.unused.slice(0,this.U),this.keepDendrogram?n.dendrogram=this.dendrogram:n.mapping=this.mapping,n};Ga.UndirectedLouvainIndex=ae;Ga.DirectedLouvainIndex=ie});var Lo=pe((tf,Co)=>{var Bh=Fa(),Uh=It(),Oh=oo(),So=uo(),Ao=co(),wo=po().createRandomIndex,Do=Eo(),Hh=Do.UndirectedLouvainIndex,$h=Do.DirectedLouvainIndex,Ro={nodeCommunityAttribute:"community",getEdgeWeight:"weight",fastLocalMoves:!0,randomWalk:!0,resolution:1,rng:Math.random};function Wn(n,a,t){var e=n.get(a);typeof e>"u"&&(e=0),e+=t,n.set(a,e)}var Vh=1e-10;function Bn(n,a,t,e,r){return Math.abs(e-r)<Vh?n===a?!1:t>n:e>r}function jh(n,a,t){var e=new Hh(a,{getEdgeWeight:t.getEdgeWeight,keepDendrogram:n,resolution:t.resolution}),r=wo(t.rng),i=!0,o=!0,s,l,u=new So(Float64Array,e.C),d,h,c,f,g,m,p,v,y,b,T,x,_,S,A,R,w=0,F=0,D=[],I,C;for(t.fastLocalMoves&&(d=new Ao(e.C));i;){if(b=e.C,i=!1,o=!0,t.fastLocalMoves){for(C=0,m=t.randomWalk?r(b):0,p=0;p<b;p++,m++)v=m%b,d.enqueue(v);for(;d.size!==0;){for(v=d.dequeue(),F++,T=0,u.clear(),s=e.belongings[v],h=e.starts[v],c=e.starts[v+1];h<c;h++)y=e.neighborhood[h],f=e.weights[h],l=e.belongings[y],T+=f,Wn(u,l,f);for(S=e.fastDeltaWithOwnCommunity(v,T,u.get(s)||0,s),_=s,g=0;g<u.size;g++)l=u.dense[g],l!==s&&(x=u.vals[g],w++,R=e.fastDelta(v,T,x,l),A=Bn(_,s,l,R,S),A&&(S=R,_=l));if(S<0){if(_=e.isolate(v,T),_===s)continue}else{if(_===s)continue;e.move(v,T,_)}for(i=!0,C++,h=e.starts[v],c=e.starts[v+1];h<c;h++)y=e.neighborhood[h],l=e.belongings[y],l!==_&&d.enqueue(y)}D.push(C)}else for(I=[],D.push(I);o;){for(o=!1,C=0,m=t.randomWalk?r(b):0,p=0;p<b;p++,m++){for(v=m%b,F++,T=0,u.clear(),s=e.belongings[v],h=e.starts[v],c=e.starts[v+1];h<c;h++)y=e.neighborhood[h],f=e.weights[h],l=e.belongings[y],T+=f,Wn(u,l,f);for(S=e.fastDeltaWithOwnCommunity(v,T,u.get(s)||0,s),_=s,g=0;g<u.size;g++)l=u.dense[g],l!==s&&(x=u.vals[g],w++,R=e.fastDelta(v,T,x,l),A=Bn(_,s,l,R,S),A&&(S=R,_=l));if(S<0){if(_=e.isolate(v,T),_===s)continue}else{if(_===s)continue;e.move(v,T,_)}o=!0,C++}I.push(C),i=o||i}i&&e.zoomOut()}var k={index:e,deltaComputations:w,nodesVisited:F,moves:D};return k}function Xh(n,a,t){var e=new $h(a,{getEdgeWeight:t.getEdgeWeight,keepDendrogram:n,resolution:t.resolution}),r=wo(t.rng),i=!0,o=!0,s,l,u=new So(Float64Array,e.C),d,h,c,f,g,m,p,v,y,b,T,x,_,S,A,R,w,F,D,I=0,C=0,k=[],G,N;for(t.fastLocalMoves&&(d=new Ao(e.C));i;){if(x=e.C,i=!1,o=!0,t.fastLocalMoves){for(N=0,v=t.randomWalk?r(x):0,y=0;y<x;y++,v++)b=v%x,d.enqueue(b);for(;d.size!==0;){for(b=d.dequeue(),C++,_=0,S=0,u.clear(),s=e.belongings[b],h=e.starts[b],c=e.starts[b+1],f=e.offsets[b];h<c;h++)g=h<f,T=e.neighborhood[h],m=e.weights[h],l=e.belongings[T],g?S+=m:_+=m,Wn(u,l,m);for(w=e.deltaWithOwnCommunity(b,_,S,u.get(s)||0,s),R=s,p=0;p<u.size;p++)l=u.dense[p],l!==s&&(A=u.vals[p],I++,D=e.delta(b,_,S,A,l),F=Bn(R,s,l,D,w),F&&(w=D,R=l));if(w<0){if(R=e.isolate(b,_,S),R===s)continue}else{if(R===s)continue;e.move(b,_,S,R)}for(i=!0,N++,h=e.starts[b],c=e.starts[b+1];h<c;h++)T=e.neighborhood[h],l=e.belongings[T],l!==R&&d.enqueue(T)}k.push(N)}else for(G=[],k.push(G);o;){for(o=!1,N=0,v=t.randomWalk?r(x):0,y=0;y<x;y++,v++){for(b=v%x,C++,_=0,S=0,u.clear(),s=e.belongings[b],h=e.starts[b],c=e.starts[b+1],f=e.offsets[b];h<c;h++)g=h<f,T=e.neighborhood[h],m=e.weights[h],l=e.belongings[T],g?S+=m:_+=m,Wn(u,l,m);for(w=e.deltaWithOwnCommunity(b,_,S,u.get(s)||0,s),R=s,p=0;p<u.size;p++)l=u.dense[p],l!==s&&(A=u.vals[p],I++,D=e.delta(b,_,S,A,l),F=Bn(R,s,l,D,w),F&&(w=D,R=l));if(w<0){if(R=e.isolate(b,_,S),R===s)continue}else{if(R===s)continue;e.move(b,_,S,R)}o=!0,N++}G.push(N),i=o||i}i&&e.zoomOut()}var L={index:e,deltaComputations:I,nodesVisited:C,moves:k};return L}function Ma(n,a,t,e){if(!Uh(t))throw new Error("graphology-communities-louvain: the given graph is not a valid graphology instance.");var r=Oh(t);if(r==="mixed")throw new Error("graphology-communities-louvain: cannot run the algorithm on a true mixed graph.");e=Bh(e,Ro);var i=0;if(t.size===0){if(n){t.forEachNode(function(h){t.setNodeAttribute(h,e.nodeCommunityAttribute,i++)});return}var o={};return t.forEachNode(function(h){o[h]=i++}),a?{communities:o,count:t.order,deltaComputations:0,dendrogram:null,level:0,modularity:NaN,moves:null,nodesVisited:0,resolution:e.resolution}:o}var s=r==="undirected"?jh:Xh,l=s(a,t,e),u=l.index;if(!a){if(n){u.assign(e.nodeCommunityAttribute);return}return u.collect()}var d={count:u.C,deltaComputations:l.deltaComputations,dendrogram:u.dendrogram,level:u.level,modularity:u.modularity(),moves:l.moves,nodesVisited:l.nodesVisited,resolution:e.resolution};return n?(u.assign(e.nodeCommunityAttribute),d):(d.communities=u.collect(),d)}var Un=Ma.bind(null,!1,!1);Un.assign=Ma.bind(null,!0,!1);Un.detailed=Ma.bind(null,!1,!0);Un.defaults=Ro;Co.exports=Un});var Ja=Ve(Dt(),1);function Ko(){let n=arguments[0];for(let a=1,t=arguments.length;a<t;a++)if(arguments[a])for(let e in arguments[a])n[e]=arguments[a][e];return n}var oe=Ko;typeof Object.assign=="function"&&(oe=Object.assign);function ye(n,a,t,e){let r=n._nodes.get(a),i=null;return r&&(e==="mixed"?i=r.out&&r.out[t]||r.undirected&&r.undirected[t]:e==="directed"?i=r.out&&r.out[t]:i=r.undirected&&r.undirected[t]),i}function le(n){return typeof n=="object"&&n!==null}function er(n){let a;for(a in n)return!1;return!0}function me(n,a,t){Object.defineProperty(n,a,{enumerable:!1,configurable:!1,writable:!0,value:t})}function Se(n,a,t){let e={enumerable:!0,configurable:!0};typeof t=="function"?e.get=t:(e.value=t,e.writable=!1),Object.defineProperty(n,a,e)}function Ka(n){return!(!le(n)||n.attributes&&!Array.isArray(n.attributes))}function Zo(){let n=Math.floor(Math.random()*256)&255;return()=>n++}function ke(){let n=arguments,a=null,t=-1;return{[Symbol.iterator](){return this},next(){let e=null;do{if(a===null){if(t++,t>=n.length)return{done:!0};a=n[t][Symbol.iterator]()}if(e=a.next(),e.done){a=null;continue}break}while(!0);return e}}}function it(){return{[Symbol.iterator](){return this},next(){return{done:!0}}}}var Lt=class extends Error{constructor(a){super(),this.name="GraphError",this.message=a}},U=class n extends Lt{constructor(a){super(a),this.name="InvalidArgumentsGraphError",typeof Error.captureStackTrace=="function"&&Error.captureStackTrace(this,n.prototype.constructor)}},B=class n extends Lt{constructor(a){super(a),this.name="NotFoundGraphError",typeof Error.captureStackTrace=="function"&&Error.captureStackTrace(this,n.prototype.constructor)}},V=class n extends Lt{constructor(a){super(a),this.name="UsageGraphError",typeof Error.captureStackTrace=="function"&&Error.captureStackTrace(this,n.prototype.constructor)}};function tr(n,a){this.key=n,this.attributes=a,this.clear()}tr.prototype.clear=function(){this.inDegree=0,this.outDegree=0,this.undirectedDegree=0,this.undirectedLoops=0,this.directedLoops=0,this.in={},this.out={},this.undirected={}};function nr(n,a){this.key=n,this.attributes=a,this.clear()}nr.prototype.clear=function(){this.inDegree=0,this.outDegree=0,this.directedLoops=0,this.in={},this.out={}};function ar(n,a){this.key=n,this.attributes=a,this.clear()}ar.prototype.clear=function(){this.undirectedDegree=0,this.undirectedLoops=0,this.undirected={}};function ot(n,a,t,e,r){this.key=a,this.attributes=r,this.undirected=n,this.source=t,this.target=e}ot.prototype.attach=function(){let n="out",a="in";this.undirected&&(n=a="undirected");let t=this.source.key,e=this.target.key;this.source[n][e]=this,!(this.undirected&&t===e)&&(this.target[a][t]=this)};ot.prototype.attachMulti=function(){let n="out",a="in",t=this.source.key,e=this.target.key;this.undirected&&(n=a="undirected");let r=this.source[n],i=r[e];if(typeof i>"u"){r[e]=this,this.undirected&&t===e||(this.target[a][t]=this);return}i.previous=this,this.next=i,r[e]=this,this.target[a][t]=this};ot.prototype.detach=function(){let n=this.source.key,a=this.target.key,t="out",e="in";this.undirected&&(t=e="undirected"),delete this.source[t][a],delete this.target[e][n]};ot.prototype.detachMulti=function(){let n=this.source.key,a=this.target.key,t="out",e="in";this.undirected&&(t=e="undirected"),this.previous===void 0?this.next===void 0?(delete this.source[t][a],delete this.target[e][n]):(this.next.previous=void 0,this.source[t][a]=this.next,this.target[e][n]=this.next):(this.previous.next=this.next,this.next!==void 0&&(this.next.previous=this.previous))};var rr=0,ir=1,Qo=2,or=3;function Pe(n,a,t,e,r,i,o){let s,l,u,d;if(e=""+e,t===rr){if(s=n._nodes.get(e),!s)throw new B(`Graph.${a}: could not find the "${e}" node in the graph.`);u=r,d=i}else if(t===or){if(r=""+r,l=n._edges.get(r),!l)throw new B(`Graph.${a}: could not find the "${r}" edge in the graph.`);let h=l.source.key,c=l.target.key;if(e===h)s=l.target;else if(e===c)s=l.source;else throw new B(`Graph.${a}: the "${e}" node is not attached to the "${r}" edge (${h}, ${c}).`);u=i,d=o}else{if(l=n._edges.get(e),!l)throw new B(`Graph.${a}: could not find the "${e}" edge in the graph.`);t===ir?s=l.source:s=l.target,u=r,d=i}return[s,u,d]}function Jo(n,a,t){n.prototype[a]=function(e,r,i){let[o,s]=Pe(this,a,t,e,r,i);return o.attributes[s]}}function es(n,a,t){n.prototype[a]=function(e,r){let[i]=Pe(this,a,t,e,r);return i.attributes}}function ts(n,a,t){n.prototype[a]=function(e,r,i){let[o,s]=Pe(this,a,t,e,r,i);return o.attributes.hasOwnProperty(s)}}function ns(n,a,t){n.prototype[a]=function(e,r,i,o){let[s,l,u]=Pe(this,a,t,e,r,i,o);return s.attributes[l]=u,this.emit("nodeAttributesUpdated",{key:s.key,type:"set",attributes:s.attributes,name:l}),this}}function as(n,a,t){n.prototype[a]=function(e,r,i,o){let[s,l,u]=Pe(this,a,t,e,r,i,o);if(typeof u!="function")throw new U(`Graph.${a}: updater should be a function.`);let d=s.attributes,h=u(d[l]);return d[l]=h,this.emit("nodeAttributesUpdated",{key:s.key,type:"set",attributes:s.attributes,name:l}),this}}function rs(n,a,t){n.prototype[a]=function(e,r,i){let[o,s]=Pe(this,a,t,e,r,i);return delete o.attributes[s],this.emit("nodeAttributesUpdated",{key:o.key,type:"remove",attributes:o.attributes,name:s}),this}}function is(n,a,t){n.prototype[a]=function(e,r,i){let[o,s]=Pe(this,a,t,e,r,i);if(!le(s))throw new U(`Graph.${a}: provided attributes are not a plain object.`);return o.attributes=s,this.emit("nodeAttributesUpdated",{key:o.key,type:"replace",attributes:o.attributes}),this}}function os(n,a,t){n.prototype[a]=function(e,r,i){let[o,s]=Pe(this,a,t,e,r,i);if(!le(s))throw new U(`Graph.${a}: provided attributes are not a plain object.`);return oe(o.attributes,s),this.emit("nodeAttributesUpdated",{key:o.key,type:"merge",attributes:o.attributes,data:s}),this}}function ss(n,a,t){n.prototype[a]=function(e,r,i){let[o,s]=Pe(this,a,t,e,r,i);if(typeof s!="function")throw new U(`Graph.${a}: provided updater is not a function.`);return o.attributes=s(o.attributes),this.emit("nodeAttributesUpdated",{key:o.key,type:"update",attributes:o.attributes}),this}}var ls=[{name:n=>`get${n}Attribute`,attacher:Jo},{name:n=>`get${n}Attributes`,attacher:es},{name:n=>`has${n}Attribute`,attacher:ts},{name:n=>`set${n}Attribute`,attacher:ns},{name:n=>`update${n}Attribute`,attacher:as},{name:n=>`remove${n}Attribute`,attacher:rs},{name:n=>`replace${n}Attributes`,attacher:is},{name:n=>`merge${n}Attributes`,attacher:os},{name:n=>`update${n}Attributes`,attacher:ss}];function us(n){ls.forEach(function({name:a,attacher:t}){t(n,a("Node"),rr),t(n,a("Source"),ir),t(n,a("Target"),Qo),t(n,a("Opposite"),or)})}function ds(n,a,t){n.prototype[a]=function(e,r){let i;if(this.type!=="mixed"&&t!=="mixed"&&t!==this.type)throw new V(`Graph.${a}: cannot find this type of edges in your ${this.type} graph.`);if(arguments.length>2){if(this.multi)throw new V(`Graph.${a}: cannot use a {source,target} combo when asking about an edge's attributes in a MultiGraph since we cannot infer the one you want information about.`);let o=""+e,s=""+r;if(r=arguments[2],i=ye(this,o,s,t),!i)throw new B(`Graph.${a}: could not find an edge for the given path ("${o}" - "${s}").`)}else{if(t!=="mixed")throw new V(`Graph.${a}: calling this method with only a key (vs. a source and target) does not make sense since an edge with this key could have the other type.`);if(e=""+e,i=this._edges.get(e),!i)throw new B(`Graph.${a}: could not find the "${e}" edge in the graph.`)}return i.attributes[r]}}function hs(n,a,t){n.prototype[a]=function(e){let r;if(this.type!=="mixed"&&t!=="mixed"&&t!==this.type)throw new V(`Graph.${a}: cannot find this type of edges in your ${this.type} graph.`);if(arguments.length>1){if(this.multi)throw new V(`Graph.${a}: cannot use a {source,target} combo when asking about an edge's attributes in a MultiGraph since we cannot infer the one you want information about.`);let i=""+e,o=""+arguments[1];if(r=ye(this,i,o,t),!r)throw new B(`Graph.${a}: could not find an edge for the given path ("${i}" - "${o}").`)}else{if(t!=="mixed")throw new V(`Graph.${a}: calling this method with only a key (vs. a source and target) does not make sense since an edge with this key could have the other type.`);if(e=""+e,r=this._edges.get(e),!r)throw new B(`Graph.${a}: could not find the "${e}" edge in the graph.`)}return r.attributes}}function cs(n,a,t){n.prototype[a]=function(e,r){let i;if(this.type!=="mixed"&&t!=="mixed"&&t!==this.type)throw new V(`Graph.${a}: cannot find this type of edges in your ${this.type} graph.`);if(arguments.length>2){if(this.multi)throw new V(`Graph.${a}: cannot use a {source,target} combo when asking about an edge's attributes in a MultiGraph since we cannot infer the one you want information about.`);let o=""+e,s=""+r;if(r=arguments[2],i=ye(this,o,s,t),!i)throw new B(`Graph.${a}: could not find an edge for the given path ("${o}" - "${s}").`)}else{if(t!=="mixed")throw new V(`Graph.${a}: calling this method with only a key (vs. a source and target) does not make sense since an edge with this key could have the other type.`);if(e=""+e,i=this._edges.get(e),!i)throw new B(`Graph.${a}: could not find the "${e}" edge in the graph.`)}return i.attributes.hasOwnProperty(r)}}function fs(n,a,t){n.prototype[a]=function(e,r,i){let o;if(this.type!=="mixed"&&t!=="mixed"&&t!==this.type)throw new V(`Graph.${a}: cannot find this type of edges in your ${this.type} graph.`);if(arguments.length>3){if(this.multi)throw new V(`Graph.${a}: cannot use a {source,target} combo when asking about an edge's attributes in a MultiGraph since we cannot infer the one you want information about.`);let s=""+e,l=""+r;if(r=arguments[2],i=arguments[3],o=ye(this,s,l,t),!o)throw new B(`Graph.${a}: could not find an edge for the given path ("${s}" - "${l}").`)}else{if(t!=="mixed")throw new V(`Graph.${a}: calling this method with only a key (vs. a source and target) does not make sense since an edge with this key could have the other type.`);if(e=""+e,o=this._edges.get(e),!o)throw new B(`Graph.${a}: could not find the "${e}" edge in the graph.`)}return o.attributes[r]=i,this.emit("edgeAttributesUpdated",{key:o.key,type:"set",attributes:o.attributes,name:r}),this}}function gs(n,a,t){n.prototype[a]=function(e,r,i){let o;if(this.type!=="mixed"&&t!=="mixed"&&t!==this.type)throw new V(`Graph.${a}: cannot find this type of edges in your ${this.type} graph.`);if(arguments.length>3){if(this.multi)throw new V(`Graph.${a}: cannot use a {source,target} combo when asking about an edge's attributes in a MultiGraph since we cannot infer the one you want information about.`);let s=""+e,l=""+r;if(r=arguments[2],i=arguments[3],o=ye(this,s,l,t),!o)throw new B(`Graph.${a}: could not find an edge for the given path ("${s}" - "${l}").`)}else{if(t!=="mixed")throw new V(`Graph.${a}: calling this method with only a key (vs. a source and target) does not make sense since an edge with this key could have the other type.`);if(e=""+e,o=this._edges.get(e),!o)throw new B(`Graph.${a}: could not find the "${e}" edge in the graph.`)}if(typeof i!="function")throw new U(`Graph.${a}: updater should be a function.`);return o.attributes[r]=i(o.attributes[r]),this.emit("edgeAttributesUpdated",{key:o.key,type:"set",attributes:o.attributes,name:r}),this}}function vs(n,a,t){n.prototype[a]=function(e,r){let i;if(this.type!=="mixed"&&t!=="mixed"&&t!==this.type)throw new V(`Graph.${a}: cannot find this type of edges in your ${this.type} graph.`);if(arguments.length>2){if(this.multi)throw new V(`Graph.${a}: cannot use a {source,target} combo when asking about an edge's attributes in a MultiGraph since we cannot infer the one you want information about.`);let o=""+e,s=""+r;if(r=arguments[2],i=ye(this,o,s,t),!i)throw new B(`Graph.${a}: could not find an edge for the given path ("${o}" - "${s}").`)}else{if(t!=="mixed")throw new V(`Graph.${a}: calling this method with only a key (vs. a source and target) does not make sense since an edge with this key could have the other type.`);if(e=""+e,i=this._edges.get(e),!i)throw new B(`Graph.${a}: could not find the "${e}" edge in the graph.`)}return delete i.attributes[r],this.emit("edgeAttributesUpdated",{key:i.key,type:"remove",attributes:i.attributes,name:r}),this}}function ps(n,a,t){n.prototype[a]=function(e,r){let i;if(this.type!=="mixed"&&t!=="mixed"&&t!==this.type)throw new V(`Graph.${a}: cannot find this type of edges in your ${this.type} graph.`);if(arguments.length>2){if(this.multi)throw new V(`Graph.${a}: cannot use a {source,target} combo when asking about an edge's attributes in a MultiGraph since we cannot infer the one you want information about.`);let o=""+e,s=""+r;if(r=arguments[2],i=ye(this,o,s,t),!i)throw new B(`Graph.${a}: could not find an edge for the given path ("${o}" - "${s}").`)}else{if(t!=="mixed")throw new V(`Graph.${a}: calling this method with only a key (vs. a source and target) does not make sense since an edge with this key could have the other type.`);if(e=""+e,i=this._edges.get(e),!i)throw new B(`Graph.${a}: could not find the "${e}" edge in the graph.`)}if(!le(r))throw new U(`Graph.${a}: provided attributes are not a plain object.`);return i.attributes=r,this.emit("edgeAttributesUpdated",{key:i.key,type:"replace",attributes:i.attributes}),this}}function ms(n,a,t){n.prototype[a]=function(e,r){let i;if(this.type!=="mixed"&&t!=="mixed"&&t!==this.type)throw new V(`Graph.${a}: cannot find this type of edges in your ${this.type} graph.`);if(arguments.length>2){if(this.multi)throw new V(`Graph.${a}: cannot use a {source,target} combo when asking about an edge's attributes in a MultiGraph since we cannot infer the one you want information about.`);let o=""+e,s=""+r;if(r=arguments[2],i=ye(this,o,s,t),!i)throw new B(`Graph.${a}: could not find an edge for the given path ("${o}" - "${s}").`)}else{if(t!=="mixed")throw new V(`Graph.${a}: calling this method with only a key (vs. a source and target) does not make sense since an edge with this key could have the other type.`);if(e=""+e,i=this._edges.get(e),!i)throw new B(`Graph.${a}: could not find the "${e}" edge in the graph.`)}if(!le(r))throw new U(`Graph.${a}: provided attributes are not a plain object.`);return oe(i.attributes,r),this.emit("edgeAttributesUpdated",{key:i.key,type:"merge",attributes:i.attributes,data:r}),this}}function ys(n,a,t){n.prototype[a]=function(e,r){let i;if(this.type!=="mixed"&&t!=="mixed"&&t!==this.type)throw new V(`Graph.${a}: cannot find this type of edges in your ${this.type} graph.`);if(arguments.length>2){if(this.multi)throw new V(`Graph.${a}: cannot use a {source,target} combo when asking about an edge's attributes in a MultiGraph since we cannot infer the one you want information about.`);let o=""+e,s=""+r;if(r=arguments[2],i=ye(this,o,s,t),!i)throw new B(`Graph.${a}: could not find an edge for the given path ("${o}" - "${s}").`)}else{if(t!=="mixed")throw new V(`Graph.${a}: calling this method with only a key (vs. a source and target) does not make sense since an edge with this key could have the other type.`);if(e=""+e,i=this._edges.get(e),!i)throw new B(`Graph.${a}: could not find the "${e}" edge in the graph.`)}if(typeof r!="function")throw new U(`Graph.${a}: provided updater is not a function.`);return i.attributes=r(i.attributes),this.emit("edgeAttributesUpdated",{key:i.key,type:"update",attributes:i.attributes}),this}}var bs=[{name:n=>`get${n}Attribute`,attacher:ds},{name:n=>`get${n}Attributes`,attacher:hs},{name:n=>`has${n}Attribute`,attacher:cs},{name:n=>`set${n}Attribute`,attacher:fs},{name:n=>`update${n}Attribute`,attacher:gs},{name:n=>`remove${n}Attribute`,attacher:vs},{name:n=>`replace${n}Attributes`,attacher:ps},{name:n=>`merge${n}Attributes`,attacher:ms},{name:n=>`update${n}Attributes`,attacher:ys}];function xs(n){bs.forEach(function({name:a,attacher:t}){t(n,a("Edge"),"mixed"),t(n,a("DirectedEdge"),"directed"),t(n,a("UndirectedEdge"),"undirected")})}var _s=[{name:"edges",type:"mixed"},{name:"inEdges",type:"directed",direction:"in"},{name:"outEdges",type:"directed",direction:"out"},{name:"inboundEdges",type:"mixed",direction:"in"},{name:"outboundEdges",type:"mixed",direction:"out"},{name:"directedEdges",type:"directed"},{name:"undirectedEdges",type:"undirected"}];function Ts(n,a,t,e){let r=!1;for(let i in a){if(i===e)continue;let o=a[i];if(r=t(o.key,o.attributes,o.source.key,o.target.key,o.source.attributes,o.target.attributes,o.undirected),n&&r)return o.key}}function Es(n,a,t,e){let r,i,o,s=!1;for(let l in a)if(l!==e){r=a[l];do{if(i=r.source,o=r.target,s=t(r.key,r.attributes,i.key,o.key,i.attributes,o.attributes,r.undirected),n&&s)return r.key;r=r.next}while(r!==void 0)}}function Hn(n,a){let t=Object.keys(n),e=t.length,r,i=0;return{[Symbol.iterator](){return this},next(){do if(r)r=r.next;else{if(i>=e)return{done:!0};let o=t[i++];if(o===a){r=void 0;continue}r=n[o]}while(!r);return{done:!1,value:{edge:r.key,attributes:r.attributes,source:r.source.key,target:r.target.key,sourceAttributes:r.source.attributes,targetAttributes:r.target.attributes,undirected:r.undirected}}}}}function Ss(n,a,t,e){let r=a[t];if(!r)return;let i=r.source,o=r.target;if(e(r.key,r.attributes,i.key,o.key,i.attributes,o.attributes,r.undirected)&&n)return r.key}function As(n,a,t,e){let r=a[t];if(!r)return;let i=!1;do{if(i=e(r.key,r.attributes,r.source.key,r.target.key,r.source.attributes,r.target.attributes,r.undirected),n&&i)return r.key;r=r.next}while(r!==void 0)}function $n(n,a){let t=n[a];if(t.next!==void 0)return{[Symbol.iterator](){return this},next(){if(!t)return{done:!0};let r={edge:t.key,attributes:t.attributes,source:t.source.key,target:t.target.key,sourceAttributes:t.source.attributes,targetAttributes:t.target.attributes,undirected:t.undirected};return t=t.next,{done:!1,value:r}}};let e=!1;return{[Symbol.iterator](){return this},next(){return e===!0?{done:!0}:(e=!0,{done:!1,value:{edge:t.key,attributes:t.attributes,source:t.source.key,target:t.target.key,sourceAttributes:t.source.attributes,targetAttributes:t.target.attributes,undirected:t.undirected}})}}}function ws(n,a){if(n.size===0)return[];if(a==="mixed"||a===n.type)return Array.from(n._edges.keys());let t=a==="undirected"?n.undirectedSize:n.directedSize,e=new Array(t),r=a==="undirected",i=n._edges.values(),o=0,s,l;for(;s=i.next(),s.done!==!0;)l=s.value,l.undirected===r&&(e[o++]=l.key);return e}function sr(n,a,t,e){if(a.size===0)return;let r=t!=="mixed"&&t!==a.type,i=t==="undirected",o,s,l=!1,u=a._edges.values();for(;o=u.next(),o.done!==!0;){if(s=o.value,r&&s.undirected!==i)continue;let{key:d,attributes:h,source:c,target:f}=s;if(l=e(d,h,c.key,f.key,c.attributes,f.attributes,s.undirected),n&&l)return d}}function Ds(n,a){if(n.size===0)return it();let t=a!=="mixed"&&a!==n.type,e=a==="undirected",r=n._edges.values();return{[Symbol.iterator](){return this},next(){let i,o;for(;;){if(i=r.next(),i.done)return i;if(o=i.value,!(t&&o.undirected!==e))break}return{value:{edge:o.key,attributes:o.attributes,source:o.source.key,target:o.target.key,sourceAttributes:o.source.attributes,targetAttributes:o.target.attributes,undirected:o.undirected},done:!1}}}}function Vn(n,a,t,e,r,i){let o=a?Es:Ts,s;if(t!=="undirected"&&(e!=="out"&&(s=o(n,r.in,i),n&&s)||e!=="in"&&(s=o(n,r.out,i,e?void 0:r.key),n&&s))||t!=="directed"&&(s=o(n,r.undirected,i),n&&s))return s}function Rs(n,a,t,e){let r=[];return Vn(!1,n,a,t,e,function(i){r.push(i)}),r}function Cs(n,a,t){let e=it();return n!=="undirected"&&(a!=="out"&&typeof t.in<"u"&&(e=ke(e,Hn(t.in))),a!=="in"&&typeof t.out<"u"&&(e=ke(e,Hn(t.out,a?void 0:t.key)))),n!=="directed"&&typeof t.undirected<"u"&&(e=ke(e,Hn(t.undirected))),e}function jn(n,a,t,e,r,i,o){let s=t?As:Ss,l;if(a!=="undirected"&&(typeof r.in<"u"&&e!=="out"&&(l=s(n,r.in,i,o),n&&l)||typeof r.out<"u"&&e!=="in"&&(e||r.key!==i)&&(l=s(n,r.out,i,o),n&&l))||a!=="directed"&&typeof r.undirected<"u"&&(l=s(n,r.undirected,i,o),n&&l))return l}function Ls(n,a,t,e,r){let i=[];return jn(!1,n,a,t,e,r,function(o){i.push(o)}),i}function ks(n,a,t,e){let r=it();return n!=="undirected"&&(typeof t.in<"u"&&a!=="out"&&e in t.in&&(r=ke(r,$n(t.in,e))),typeof t.out<"u"&&a!=="in"&&e in t.out&&(a||t.key!==e)&&(r=ke(r,$n(t.out,e)))),n!=="directed"&&typeof t.undirected<"u"&&e in t.undirected&&(r=ke(r,$n(t.undirected,e))),r}function Ps(n,a){let{name:t,type:e,direction:r}=a;n.prototype[t]=function(i,o){if(e!=="mixed"&&this.type!=="mixed"&&e!==this.type)return[];if(!arguments.length)return ws(this,e);if(arguments.length===1){i=""+i;let s=this._nodes.get(i);if(typeof s>"u")throw new B(`Graph.${t}: could not find the "${i}" node in the graph.`);return Rs(this.multi,e==="mixed"?this.type:e,r,s)}if(arguments.length===2){i=""+i,o=""+o;let s=this._nodes.get(i);if(!s)throw new B(`Graph.${t}:  could not find the "${i}" source node in the graph.`);if(!this._nodes.has(o))throw new B(`Graph.${t}:  could not find the "${o}" target node in the graph.`);return Ls(e,this.multi,r,s,o)}throw new U(`Graph.${t}: too many arguments (expecting 0, 1 or 2 and got ${arguments.length}).`)}}function Fs(n,a){let{name:t,type:e,direction:r}=a,i="forEach"+t[0].toUpperCase()+t.slice(1,-1);n.prototype[i]=function(u,d,h){if(!(e!=="mixed"&&this.type!=="mixed"&&e!==this.type)){if(arguments.length===1)return h=u,sr(!1,this,e,h);if(arguments.length===2){u=""+u,h=d;let c=this._nodes.get(u);if(typeof c>"u")throw new B(`Graph.${i}: could not find the "${u}" node in the graph.`);return Vn(!1,this.multi,e==="mixed"?this.type:e,r,c,h)}if(arguments.length===3){u=""+u,d=""+d;let c=this._nodes.get(u);if(!c)throw new B(`Graph.${i}:  could not find the "${u}" source node in the graph.`);if(!this._nodes.has(d))throw new B(`Graph.${i}:  could not find the "${d}" target node in the graph.`);return jn(!1,e,this.multi,r,c,d,h)}throw new U(`Graph.${i}: too many arguments (expecting 1, 2 or 3 and got ${arguments.length}).`)}};let o="map"+t[0].toUpperCase()+t.slice(1);n.prototype[o]=function(){let u=Array.prototype.slice.call(arguments),d=u.pop(),h;if(u.length===0){let c=0;e!=="directed"&&(c+=this.undirectedSize),e!=="undirected"&&(c+=this.directedSize),h=new Array(c);let f=0;u.push((g,m,p,v,y,b,T)=>{h[f++]=d(g,m,p,v,y,b,T)})}else h=[],u.push((c,f,g,m,p,v,y)=>{h.push(d(c,f,g,m,p,v,y))});return this[i].apply(this,u),h};let s="filter"+t[0].toUpperCase()+t.slice(1);n.prototype[s]=function(){let u=Array.prototype.slice.call(arguments),d=u.pop(),h=[];return u.push((c,f,g,m,p,v,y)=>{d(c,f,g,m,p,v,y)&&h.push(c)}),this[i].apply(this,u),h};let l="reduce"+t[0].toUpperCase()+t.slice(1);n.prototype[l]=function(){let u=Array.prototype.slice.call(arguments);if(u.length<2||u.length>4)throw new U(`Graph.${l}: invalid number of arguments (expecting 2, 3 or 4 and got ${u.length}).`);if(typeof u[u.length-1]=="function"&&typeof u[u.length-2]!="function")throw new U(`Graph.${l}: missing initial value. You must provide it because the callback takes more than one argument and we cannot infer the initial value from the first iteration, as you could with a simple array.`);let d,h;u.length===2?(d=u[0],h=u[1],u=[]):u.length===3?(d=u[1],h=u[2],u=[u[0]]):u.length===4&&(d=u[2],h=u[3],u=[u[0],u[1]]);let c=h;return u.push((f,g,m,p,v,y,b)=>{c=d(c,f,g,m,p,v,y,b)}),this[i].apply(this,u),c}}function Is(n,a){let{name:t,type:e,direction:r}=a,i="find"+t[0].toUpperCase()+t.slice(1,-1);n.prototype[i]=function(l,u,d){if(e!=="mixed"&&this.type!=="mixed"&&e!==this.type)return!1;if(arguments.length===1)return d=l,sr(!0,this,e,d);if(arguments.length===2){l=""+l,d=u;let h=this._nodes.get(l);if(typeof h>"u")throw new B(`Graph.${i}: could not find the "${l}" node in the graph.`);return Vn(!0,this.multi,e==="mixed"?this.type:e,r,h,d)}if(arguments.length===3){l=""+l,u=""+u;let h=this._nodes.get(l);if(!h)throw new B(`Graph.${i}:  could not find the "${l}" source node in the graph.`);if(!this._nodes.has(u))throw new B(`Graph.${i}:  could not find the "${u}" target node in the graph.`);return jn(!0,e,this.multi,r,h,u,d)}throw new U(`Graph.${i}: too many arguments (expecting 1, 2 or 3 and got ${arguments.length}).`)};let o="some"+t[0].toUpperCase()+t.slice(1,-1);n.prototype[o]=function(){let l=Array.prototype.slice.call(arguments),u=l.pop();return l.push((h,c,f,g,m,p,v)=>u(h,c,f,g,m,p,v)),!!this[i].apply(this,l)};let s="every"+t[0].toUpperCase()+t.slice(1,-1);n.prototype[s]=function(){let l=Array.prototype.slice.call(arguments),u=l.pop();return l.push((h,c,f,g,m,p,v)=>!u(h,c,f,g,m,p,v)),!this[i].apply(this,l)}}function Ns(n,a){let{name:t,type:e,direction:r}=a,i=t.slice(0,-1)+"Entries";n.prototype[i]=function(o,s){if(e!=="mixed"&&this.type!=="mixed"&&e!==this.type)return it();if(!arguments.length)return Ds(this,e);if(arguments.length===1){o=""+o;let l=this._nodes.get(o);if(!l)throw new B(`Graph.${i}: could not find the "${o}" node in the graph.`);return Cs(e,r,l)}if(arguments.length===2){o=""+o,s=""+s;let l=this._nodes.get(o);if(!l)throw new B(`Graph.${i}:  could not find the "${o}" source node in the graph.`);if(!this._nodes.has(s))throw new B(`Graph.${i}:  could not find the "${s}" target node in the graph.`);return ks(e,r,l,s)}throw new U(`Graph.${i}: too many arguments (expecting 0, 1 or 2 and got ${arguments.length}).`)}}function Gs(n){_s.forEach(a=>{Ps(n,a),Fs(n,a),Is(n,a),Ns(n,a)})}var Ms=[{name:"neighbors",type:"mixed"},{name:"inNeighbors",type:"directed",direction:"in"},{name:"outNeighbors",type:"directed",direction:"out"},{name:"inboundNeighbors",type:"mixed",direction:"in"},{name:"outboundNeighbors",type:"mixed",direction:"out"},{name:"directedNeighbors",type:"directed"},{name:"undirectedNeighbors",type:"undirected"}];function nn(){this.A=null,this.B=null}nn.prototype.wrap=function(n){this.A===null?this.A=n:this.B===null&&(this.B=n)};nn.prototype.has=function(n){return this.A!==null&&n in this.A||this.B!==null&&n in this.B};function Rt(n,a,t,e,r){for(let i in e){let o=e[i],s=o.source,l=o.target,u=s===t?l:s;if(a&&a.has(u.key))continue;let d=r(u.key,u.attributes);if(n&&d)return u.key}}function Xn(n,a,t,e,r){if(a!=="mixed"){if(a==="undirected")return Rt(n,null,e,e.undirected,r);if(typeof t=="string")return Rt(n,null,e,e[t],r)}let i=new nn,o;if(a!=="undirected"){if(t!=="out"){if(o=Rt(n,null,e,e.in,r),n&&o)return o;i.wrap(e.in)}if(t!=="in"){if(o=Rt(n,i,e,e.out,r),n&&o)return o;i.wrap(e.out)}}if(a!=="directed"&&(o=Rt(n,i,e,e.undirected,r),n&&o))return o}function zs(n,a,t){if(n!=="mixed"){if(n==="undirected")return Object.keys(t.undirected);if(typeof a=="string")return Object.keys(t[a])}let e=[];return Xn(!1,n,a,t,function(r){e.push(r)}),e}function Ct(n,a,t){let e=Object.keys(t),r=e.length,i=0;return{[Symbol.iterator](){return this},next(){let o=null;do{if(i>=r)return n&&n.wrap(t),{done:!0};let s=t[e[i++]],l=s.source,u=s.target;if(o=l===a?u:l,n&&n.has(o.key)){o=null;continue}}while(o===null);return{done:!1,value:{neighbor:o.key,attributes:o.attributes}}}}}function Ws(n,a,t){if(n!=="mixed"){if(n==="undirected")return Ct(null,t,t.undirected);if(typeof a=="string")return Ct(null,t,t[a])}let e=it(),r=new nn;return n!=="undirected"&&(a!=="out"&&(e=ke(e,Ct(r,t,t.in))),a!=="in"&&(e=ke(e,Ct(r,t,t.out)))),n!=="directed"&&(e=ke(e,Ct(r,t,t.undirected))),e}function Bs(n,a){let{name:t,type:e,direction:r}=a;n.prototype[t]=function(i){if(e!=="mixed"&&this.type!=="mixed"&&e!==this.type)return[];i=""+i;let o=this._nodes.get(i);if(typeof o>"u")throw new B(`Graph.${t}: could not find the "${i}" node in the graph.`);return zs(e==="mixed"?this.type:e,r,o)}}function Us(n,a){let{name:t,type:e,direction:r}=a,i="forEach"+t[0].toUpperCase()+t.slice(1,-1);n.prototype[i]=function(u,d){if(e!=="mixed"&&this.type!=="mixed"&&e!==this.type)return;u=""+u;let h=this._nodes.get(u);if(typeof h>"u")throw new B(`Graph.${i}: could not find the "${u}" node in the graph.`);Xn(!1,e==="mixed"?this.type:e,r,h,d)};let o="map"+t[0].toUpperCase()+t.slice(1);n.prototype[o]=function(u,d){let h=[];return this[i](u,(c,f)=>{h.push(d(c,f))}),h};let s="filter"+t[0].toUpperCase()+t.slice(1);n.prototype[s]=function(u,d){let h=[];return this[i](u,(c,f)=>{d(c,f)&&h.push(c)}),h};let l="reduce"+t[0].toUpperCase()+t.slice(1);n.prototype[l]=function(u,d,h){if(arguments.length<3)throw new U(`Graph.${l}: missing initial value. You must provide it because the callback takes more than one argument and we cannot infer the initial value from the first iteration, as you could with a simple array.`);let c=h;return this[i](u,(f,g)=>{c=d(c,f,g)}),c}}function Os(n,a){let{name:t,type:e,direction:r}=a,i=t[0].toUpperCase()+t.slice(1,-1),o="find"+i;n.prototype[o]=function(u,d){if(e!=="mixed"&&this.type!=="mixed"&&e!==this.type)return;u=""+u;let h=this._nodes.get(u);if(typeof h>"u")throw new B(`Graph.${o}: could not find the "${u}" node in the graph.`);return Xn(!0,e==="mixed"?this.type:e,r,h,d)};let s="some"+i;n.prototype[s]=function(u,d){return!!this[o](u,d)};let l="every"+i;n.prototype[l]=function(u,d){return!this[o](u,(c,f)=>!d(c,f))}}function Hs(n,a){let{name:t,type:e,direction:r}=a,i=t.slice(0,-1)+"Entries";n.prototype[i]=function(o){if(e!=="mixed"&&this.type!=="mixed"&&e!==this.type)return it();o=""+o;let s=this._nodes.get(o);if(typeof s>"u")throw new B(`Graph.${i}: could not find the "${o}" node in the graph.`);return Ws(e==="mixed"?this.type:e,r,s)}}function $s(n){Ms.forEach(a=>{Bs(n,a),Us(n,a),Os(n,a),Hs(n,a)})}function Kt(n,a,t,e,r){let i=e._nodes.values(),o=e.type,s,l,u,d,h,c,f;for(;s=i.next(),s.done!==!0;){let g=!1;if(l=s.value,o!=="undirected"){d=l.out;for(u in d){h=d[u];do{if(c=h.target,g=!0,f=r(l.key,c.key,l.attributes,c.attributes,h.key,h.attributes,h.undirected),n&&f)return h;h=h.next}while(h)}}if(o!=="directed"){d=l.undirected;for(u in d)if(!(a&&l.key>u)){h=d[u];do{if(c=h.target,c.key!==u&&(c=h.source),g=!0,f=r(l.key,c.key,l.attributes,c.attributes,h.key,h.attributes,h.undirected),n&&f)return h;h=h.next}while(h)}}if(t&&!g&&(f=r(l.key,null,l.attributes,null,null,null,null),n&&f))return null}}function Vs(n,a){let t={key:n};return er(a.attributes)||(t.attributes=oe({},a.attributes)),t}function js(n,a,t){let e={key:a,source:t.source.key,target:t.target.key};return er(t.attributes)||(e.attributes=oe({},t.attributes)),n==="mixed"&&t.undirected&&(e.undirected=!0),e}function Xs(n){if(!le(n))throw new U('Graph.import: invalid serialized node. A serialized node should be a plain object with at least a "key" property.');if(!("key"in n))throw new U("Graph.import: serialized node is missing its key.");if("attributes"in n&&(!le(n.attributes)||n.attributes===null))throw new U("Graph.import: invalid attributes. Attributes should be a plain object, null or omitted.")}function qs(n){if(!le(n))throw new U('Graph.import: invalid serialized edge. A serialized edge should be a plain object with at least a "source" & "target" property.');if(!("source"in n))throw new U("Graph.import: serialized edge is missing its source.");if(!("target"in n))throw new U("Graph.import: serialized edge is missing its target.");if("attributes"in n&&(!le(n.attributes)||n.attributes===null))throw new U("Graph.import: invalid attributes. Attributes should be a plain object, null or omitted.");if("undirected"in n&&typeof n.undirected!="boolean")throw new U("Graph.import: invalid undirectedness information. Undirected should be boolean or omitted.")}var Ys=Zo(),Ks=new Set(["directed","undirected","mixed"]),Za=new Set(["domain","_events","_eventsCount","_maxListeners"]),Zs=[{name:n=>`${n}Edge`,generateKey:!0},{name:n=>`${n}DirectedEdge`,generateKey:!0,type:"directed"},{name:n=>`${n}UndirectedEdge`,generateKey:!0,type:"undirected"},{name:n=>`${n}EdgeWithKey`},{name:n=>`${n}DirectedEdgeWithKey`,type:"directed"},{name:n=>`${n}UndirectedEdgeWithKey`,type:"undirected"}],Qs={allowSelfLoops:!0,multi:!1,type:"mixed"};function Js(n,a,t){if(t&&!le(t))throw new U(`Graph.addNode: invalid attributes. Expecting an object but got "${t}"`);if(a=""+a,t=t||{},n._nodes.has(a))throw new V(`Graph.addNode: the "${a}" node already exist in the graph.`);let e=new n.NodeDataClass(a,t);return n._nodes.set(a,e),n.emit("nodeAdded",{key:a,attributes:t}),e}function Qa(n,a,t){let e=new n.NodeDataClass(a,t);return n._nodes.set(a,e),n.emit("nodeAdded",{key:a,attributes:t}),e}function lr(n,a,t,e,r,i,o,s){if(!e&&n.type==="undirected")throw new V(`Graph.${a}: you cannot add a directed edge to an undirected graph. Use the #.addEdge or #.addUndirectedEdge instead.`);if(e&&n.type==="directed")throw new V(`Graph.${a}: you cannot add an undirected edge to a directed graph. Use the #.addEdge or #.addDirectedEdge instead.`);if(s&&!le(s))throw new U(`Graph.${a}: invalid attributes. Expecting an object but got "${s}"`);if(i=""+i,o=""+o,s=s||{},!n.allowSelfLoops&&i===o)throw new V(`Graph.${a}: source & target are the same ("${i}"), thus creating a loop explicitly forbidden by this graph 'allowSelfLoops' option set to false.`);let l=n._nodes.get(i),u=n._nodes.get(o);if(!l)throw new B(`Graph.${a}: source node "${i}" not found.`);if(!u)throw new B(`Graph.${a}: target node "${o}" not found.`);let d={key:null,undirected:e,source:i,target:o,attributes:s};if(t)r=n._edgeKeyGenerator();else if(r=""+r,n._edges.has(r))throw new V(`Graph.${a}: the "${r}" edge already exists in the graph.`);if(!n.multi&&(e?typeof l.undirected[o]<"u":typeof l.out[o]<"u"))throw new V(`Graph.${a}: an edge linking "${i}" to "${o}" already exists. If you really want to add multiple edges linking those nodes, you should create a multi graph by using the 'multi' option.`);let h=new ot(e,r,l,u,s);n._edges.set(r,h);let c=i===o;return e?(l.undirectedDegree++,u.undirectedDegree++,c&&(l.undirectedLoops++,n._undirectedSelfLoopCount++)):(l.outDegree++,u.inDegree++,c&&(l.directedLoops++,n._directedSelfLoopCount++)),n.multi?h.attachMulti():h.attach(),e?n._undirectedSize++:n._directedSize++,d.key=r,n.emit("edgeAdded",d),r}function el(n,a,t,e,r,i,o,s,l){if(!e&&n.type==="undirected")throw new V(`Graph.${a}: you cannot merge/update a directed edge to an undirected graph. Use the #.mergeEdge/#.updateEdge or #.addUndirectedEdge instead.`);if(e&&n.type==="directed")throw new V(`Graph.${a}: you cannot merge/update an undirected edge to a directed graph. Use the #.mergeEdge/#.updateEdge or #.addDirectedEdge instead.`);if(s){if(l){if(typeof s!="function")throw new U(`Graph.${a}: invalid updater function. Expecting a function but got "${s}"`)}else if(!le(s))throw new U(`Graph.${a}: invalid attributes. Expecting an object but got "${s}"`)}i=""+i,o=""+o;let u;if(l&&(u=s,s=void 0),!n.allowSelfLoops&&i===o)throw new V(`Graph.${a}: source & target are the same ("${i}"), thus creating a loop explicitly forbidden by this graph 'allowSelfLoops' option set to false.`);let d=n._nodes.get(i),h=n._nodes.get(o),c,f;if(!t&&(c=n._edges.get(r),c)){if((c.source.key!==i||c.target.key!==o)&&(!e||c.source.key!==o||c.target.key!==i))throw new V(`Graph.${a}: inconsistency detected when attempting to merge the "${r}" edge with "${i}" source & "${o}" target vs. ("${c.source.key}", "${c.target.key}").`);f=c}if(!f&&!n.multi&&d&&(f=e?d.undirected[o]:d.out[o]),f){let y=[f.key,!1,!1,!1];if(l?!u:!s)return y;if(l){let b=f.attributes;f.attributes=u(b),n.emit("edgeAttributesUpdated",{type:"replace",key:f.key,attributes:f.attributes})}else oe(f.attributes,s),n.emit("edgeAttributesUpdated",{type:"merge",key:f.key,attributes:f.attributes,data:s});return y}s=s||{},l&&u&&(s=u(s));let g={key:null,undirected:e,source:i,target:o,attributes:s};if(t)r=n._edgeKeyGenerator();else if(r=""+r,n._edges.has(r))throw new V(`Graph.${a}: the "${r}" edge already exists in the graph.`);let m=!1,p=!1;d||(d=Qa(n,i,{}),m=!0,i===o&&(h=d,p=!0)),h||(h=Qa(n,o,{}),p=!0),c=new ot(e,r,d,h,s),n._edges.set(r,c);let v=i===o;return e?(d.undirectedDegree++,h.undirectedDegree++,v&&(d.undirectedLoops++,n._undirectedSelfLoopCount++)):(d.outDegree++,h.inDegree++,v&&(d.directedLoops++,n._directedSelfLoopCount++)),n.multi?c.attachMulti():c.attach(),e?n._undirectedSize++:n._directedSize++,g.key=r,n.emit("edgeAdded",g),[r,!0,m,p]}function rt(n,a){n._edges.delete(a.key);let{source:t,target:e,attributes:r}=a,i=a.undirected,o=t===e;i?(t.undirectedDegree--,e.undirectedDegree--,o&&(t.undirectedLoops--,n._undirectedSelfLoopCount--)):(t.outDegree--,e.inDegree--,o&&(t.directedLoops--,n._directedSelfLoopCount--)),n.multi?a.detachMulti():a.detach(),i?n._undirectedSize--:n._directedSize--,n.emit("edgeDropped",{key:a.key,attributes:r,source:t.key,target:e.key,undirected:i})}var ee=class n extends Ja.EventEmitter{constructor(a){if(super(),a=oe({},Qs,a),typeof a.multi!="boolean")throw new U(`Graph.constructor: invalid 'multi' option. Expecting a boolean but got "${a.multi}".`);if(!Ks.has(a.type))throw new U(`Graph.constructor: invalid 'type' option. Should be one of "mixed", "directed" or "undirected" but got "${a.type}".`);if(typeof a.allowSelfLoops!="boolean")throw new U(`Graph.constructor: invalid 'allowSelfLoops' option. Expecting a boolean but got "${a.allowSelfLoops}".`);let t=a.type==="mixed"?tr:a.type==="directed"?nr:ar;me(this,"NodeDataClass",t);let e="geid_"+Ys()+"_",r=0,i=()=>{let o;do o=e+r++;while(this._edges.has(o));return o};me(this,"_attributes",{}),me(this,"_nodes",new Map),me(this,"_edges",new Map),me(this,"_directedSize",0),me(this,"_undirectedSize",0),me(this,"_directedSelfLoopCount",0),me(this,"_undirectedSelfLoopCount",0),me(this,"_edgeKeyGenerator",i),me(this,"_options",a),Za.forEach(o=>me(this,o,this[o])),Se(this,"order",()=>this._nodes.size),Se(this,"size",()=>this._edges.size),Se(this,"directedSize",()=>this._directedSize),Se(this,"undirectedSize",()=>this._undirectedSize),Se(this,"selfLoopCount",()=>this._directedSelfLoopCount+this._undirectedSelfLoopCount),Se(this,"directedSelfLoopCount",()=>this._directedSelfLoopCount),Se(this,"undirectedSelfLoopCount",()=>this._undirectedSelfLoopCount),Se(this,"multi",this._options.multi),Se(this,"type",this._options.type),Se(this,"allowSelfLoops",this._options.allowSelfLoops),Se(this,"implementation",()=>"graphology")}_resetInstanceCounters(){this._directedSize=0,this._undirectedSize=0,this._directedSelfLoopCount=0,this._undirectedSelfLoopCount=0}hasNode(a){return this._nodes.has(""+a)}hasDirectedEdge(a,t){if(this.type==="undirected")return!1;if(arguments.length===1){let e=""+a,r=this._edges.get(e);return!!r&&!r.undirected}else if(arguments.length===2){a=""+a,t=""+t;let e=this._nodes.get(a);return e?e.out.hasOwnProperty(t):!1}throw new U(`Graph.hasDirectedEdge: invalid arity (${arguments.length}, instead of 1 or 2). You can either ask for an edge id or for the existence of an edge between a source & a target.`)}hasUndirectedEdge(a,t){if(this.type==="directed")return!1;if(arguments.length===1){let e=""+a,r=this._edges.get(e);return!!r&&r.undirected}else if(arguments.length===2){a=""+a,t=""+t;let e=this._nodes.get(a);return e?e.undirected.hasOwnProperty(t):!1}throw new U(`Graph.hasDirectedEdge: invalid arity (${arguments.length}, instead of 1 or 2). You can either ask for an edge id or for the existence of an edge between a source & a target.`)}hasEdge(a,t){if(arguments.length===1){let e=""+a;return this._edges.has(e)}else if(arguments.length===2){a=""+a,t=""+t;let e=this._nodes.get(a);return e?typeof e.out<"u"&&e.out.hasOwnProperty(t)||typeof e.undirected<"u"&&e.undirected.hasOwnProperty(t):!1}throw new U(`Graph.hasEdge: invalid arity (${arguments.length}, instead of 1 or 2). You can either ask for an edge id or for the existence of an edge between a source & a target.`)}directedEdge(a,t){if(this.type==="undirected")return;if(a=""+a,t=""+t,this.multi)throw new V("Graph.directedEdge: this method is irrelevant with multigraphs since there might be multiple edges between source & target. See #.directedEdges instead.");let e=this._nodes.get(a);if(!e)throw new B(`Graph.directedEdge: could not find the "${a}" source node in the graph.`);if(!this._nodes.has(t))throw new B(`Graph.directedEdge: could not find the "${t}" target node in the graph.`);let r=e.out&&e.out[t]||void 0;if(r)return r.key}undirectedEdge(a,t){if(this.type==="directed")return;if(a=""+a,t=""+t,this.multi)throw new V("Graph.undirectedEdge: this method is irrelevant with multigraphs since there might be multiple edges between source & target. See #.undirectedEdges instead.");let e=this._nodes.get(a);if(!e)throw new B(`Graph.undirectedEdge: could not find the "${a}" source node in the graph.`);if(!this._nodes.has(t))throw new B(`Graph.undirectedEdge: could not find the "${t}" target node in the graph.`);let r=e.undirected&&e.undirected[t]||void 0;if(r)return r.key}edge(a,t){if(this.multi)throw new V("Graph.edge: this method is irrelevant with multigraphs since there might be multiple edges between source & target. See #.edges instead.");a=""+a,t=""+t;let e=this._nodes.get(a);if(!e)throw new B(`Graph.edge: could not find the "${a}" source node in the graph.`);if(!this._nodes.has(t))throw new B(`Graph.edge: could not find the "${t}" target node in the graph.`);let r=e.out&&e.out[t]||e.undirected&&e.undirected[t]||void 0;if(r)return r.key}areDirectedNeighbors(a,t){a=""+a,t=""+t;let e=this._nodes.get(a);if(!e)throw new B(`Graph.areDirectedNeighbors: could not find the "${a}" node in the graph.`);return this.type==="undirected"?!1:t in e.in||t in e.out}areOutNeighbors(a,t){a=""+a,t=""+t;let e=this._nodes.get(a);if(!e)throw new B(`Graph.areOutNeighbors: could not find the "${a}" node in the graph.`);return this.type==="undirected"?!1:t in e.out}areInNeighbors(a,t){a=""+a,t=""+t;let e=this._nodes.get(a);if(!e)throw new B(`Graph.areInNeighbors: could not find the "${a}" node in the graph.`);return this.type==="undirected"?!1:t in e.in}areUndirectedNeighbors(a,t){a=""+a,t=""+t;let e=this._nodes.get(a);if(!e)throw new B(`Graph.areUndirectedNeighbors: could not find the "${a}" node in the graph.`);return this.type==="directed"?!1:t in e.undirected}areNeighbors(a,t){a=""+a,t=""+t;let e=this._nodes.get(a);if(!e)throw new B(`Graph.areNeighbors: could not find the "${a}" node in the graph.`);return this.type!=="undirected"&&(t in e.in||t in e.out)||this.type!=="directed"&&t in e.undirected}areInboundNeighbors(a,t){a=""+a,t=""+t;let e=this._nodes.get(a);if(!e)throw new B(`Graph.areInboundNeighbors: could not find the "${a}" node in the graph.`);return this.type!=="undirected"&&t in e.in||this.type!=="directed"&&t in e.undirected}areOutboundNeighbors(a,t){a=""+a,t=""+t;let e=this._nodes.get(a);if(!e)throw new B(`Graph.areOutboundNeighbors: could not find the "${a}" node in the graph.`);return this.type!=="undirected"&&t in e.out||this.type!=="directed"&&t in e.undirected}inDegree(a){a=""+a;let t=this._nodes.get(a);if(!t)throw new B(`Graph.inDegree: could not find the "${a}" node in the graph.`);return this.type==="undirected"?0:t.inDegree}outDegree(a){a=""+a;let t=this._nodes.get(a);if(!t)throw new B(`Graph.outDegree: could not find the "${a}" node in the graph.`);return this.type==="undirected"?0:t.outDegree}directedDegree(a){a=""+a;let t=this._nodes.get(a);if(!t)throw new B(`Graph.directedDegree: could not find the "${a}" node in the graph.`);return this.type==="undirected"?0:t.inDegree+t.outDegree}undirectedDegree(a){a=""+a;let t=this._nodes.get(a);if(!t)throw new B(`Graph.undirectedDegree: could not find the "${a}" node in the graph.`);return this.type==="directed"?0:t.undirectedDegree}inboundDegree(a){a=""+a;let t=this._nodes.get(a);if(!t)throw new B(`Graph.inboundDegree: could not find the "${a}" node in the graph.`);let e=0;return this.type!=="directed"&&(e+=t.undirectedDegree),this.type!=="undirected"&&(e+=t.inDegree),e}outboundDegree(a){a=""+a;let t=this._nodes.get(a);if(!t)throw new B(`Graph.outboundDegree: could not find the "${a}" node in the graph.`);let e=0;return this.type!=="directed"&&(e+=t.undirectedDegree),this.type!=="undirected"&&(e+=t.outDegree),e}degree(a){a=""+a;let t=this._nodes.get(a);if(!t)throw new B(`Graph.degree: could not find the "${a}" node in the graph.`);let e=0;return this.type!=="directed"&&(e+=t.undirectedDegree),this.type!=="undirected"&&(e+=t.inDegree+t.outDegree),e}inDegreeWithoutSelfLoops(a){a=""+a;let t=this._nodes.get(a);if(!t)throw new B(`Graph.inDegreeWithoutSelfLoops: could not find the "${a}" node in the graph.`);return this.type==="undirected"?0:t.inDegree-t.directedLoops}outDegreeWithoutSelfLoops(a){a=""+a;let t=this._nodes.get(a);if(!t)throw new B(`Graph.outDegreeWithoutSelfLoops: could not find the "${a}" node in the graph.`);return this.type==="undirected"?0:t.outDegree-t.directedLoops}directedDegreeWithoutSelfLoops(a){a=""+a;let t=this._nodes.get(a);if(!t)throw new B(`Graph.directedDegreeWithoutSelfLoops: could not find the "${a}" node in the graph.`);return this.type==="undirected"?0:t.inDegree+t.outDegree-t.directedLoops*2}undirectedDegreeWithoutSelfLoops(a){a=""+a;let t=this._nodes.get(a);if(!t)throw new B(`Graph.undirectedDegreeWithoutSelfLoops: could not find the "${a}" node in the graph.`);return this.type==="directed"?0:t.undirectedDegree-t.undirectedLoops*2}inboundDegreeWithoutSelfLoops(a){a=""+a;let t=this._nodes.get(a);if(!t)throw new B(`Graph.inboundDegreeWithoutSelfLoops: could not find the "${a}" node in the graph.`);let e=0,r=0;return this.type!=="directed"&&(e+=t.undirectedDegree,r+=t.undirectedLoops*2),this.type!=="undirected"&&(e+=t.inDegree,r+=t.directedLoops),e-r}outboundDegreeWithoutSelfLoops(a){a=""+a;let t=this._nodes.get(a);if(!t)throw new B(`Graph.outboundDegreeWithoutSelfLoops: could not find the "${a}" node in the graph.`);let e=0,r=0;return this.type!=="directed"&&(e+=t.undirectedDegree,r+=t.undirectedLoops*2),this.type!=="undirected"&&(e+=t.outDegree,r+=t.directedLoops),e-r}degreeWithoutSelfLoops(a){a=""+a;let t=this._nodes.get(a);if(!t)throw new B(`Graph.degreeWithoutSelfLoops: could not find the "${a}" node in the graph.`);let e=0,r=0;return this.type!=="directed"&&(e+=t.undirectedDegree,r+=t.undirectedLoops*2),this.type!=="undirected"&&(e+=t.inDegree+t.outDegree,r+=t.directedLoops*2),e-r}source(a){a=""+a;let t=this._edges.get(a);if(!t)throw new B(`Graph.source: could not find the "${a}" edge in the graph.`);return t.source.key}target(a){a=""+a;let t=this._edges.get(a);if(!t)throw new B(`Graph.target: could not find the "${a}" edge in the graph.`);return t.target.key}extremities(a){a=""+a;let t=this._edges.get(a);if(!t)throw new B(`Graph.extremities: could not find the "${a}" edge in the graph.`);return[t.source.key,t.target.key]}opposite(a,t){a=""+a,t=""+t;let e=this._edges.get(t);if(!e)throw new B(`Graph.opposite: could not find the "${t}" edge in the graph.`);let r=e.source.key,i=e.target.key;if(a===r)return i;if(a===i)return r;throw new B(`Graph.opposite: the "${a}" node is not attached to the "${t}" edge (${r}, ${i}).`)}hasExtremity(a,t){a=""+a,t=""+t;let e=this._edges.get(a);if(!e)throw new B(`Graph.hasExtremity: could not find the "${a}" edge in the graph.`);return e.source.key===t||e.target.key===t}isUndirected(a){a=""+a;let t=this._edges.get(a);if(!t)throw new B(`Graph.isUndirected: could not find the "${a}" edge in the graph.`);return t.undirected}isDirected(a){a=""+a;let t=this._edges.get(a);if(!t)throw new B(`Graph.isDirected: could not find the "${a}" edge in the graph.`);return!t.undirected}isSelfLoop(a){a=""+a;let t=this._edges.get(a);if(!t)throw new B(`Graph.isSelfLoop: could not find the "${a}" edge in the graph.`);return t.source===t.target}addNode(a,t){return Js(this,a,t).key}mergeNode(a,t){if(t&&!le(t))throw new U(`Graph.mergeNode: invalid attributes. Expecting an object but got "${t}"`);a=""+a,t=t||{};let e=this._nodes.get(a);return e?(t&&(oe(e.attributes,t),this.emit("nodeAttributesUpdated",{type:"merge",key:a,attributes:e.attributes,data:t})),[a,!1]):(e=new this.NodeDataClass(a,t),this._nodes.set(a,e),this.emit("nodeAdded",{key:a,attributes:t}),[a,!0])}updateNode(a,t){if(t&&typeof t!="function")throw new U(`Graph.updateNode: invalid updater function. Expecting a function but got "${t}"`);a=""+a;let e=this._nodes.get(a);if(e){if(t){let i=e.attributes;e.attributes=t(i),this.emit("nodeAttributesUpdated",{type:"replace",key:a,attributes:e.attributes})}return[a,!1]}let r=t?t({}):{};return e=new this.NodeDataClass(a,r),this._nodes.set(a,e),this.emit("nodeAdded",{key:a,attributes:r}),[a,!0]}dropNode(a){a=""+a;let t=this._nodes.get(a);if(!t)throw new B(`Graph.dropNode: could not find the "${a}" node in the graph.`);let e;if(this.type!=="undirected"){for(let r in t.out){e=t.out[r];do rt(this,e),e=e.next;while(e)}for(let r in t.in){e=t.in[r];do rt(this,e),e=e.next;while(e)}}if(this.type!=="directed")for(let r in t.undirected){e=t.undirected[r];do rt(this,e),e=e.next;while(e)}this._nodes.delete(a),this.emit("nodeDropped",{key:a,attributes:t.attributes})}dropEdge(a){let t;if(arguments.length>1){let e=""+arguments[0],r=""+arguments[1];if(t=ye(this,e,r,this.type),!t)throw new B(`Graph.dropEdge: could not find the "${e}" -> "${r}" edge in the graph.`)}else if(a=""+a,t=this._edges.get(a),!t)throw new B(`Graph.dropEdge: could not find the "${a}" edge in the graph.`);return rt(this,t),this}dropDirectedEdge(a,t){if(arguments.length<2)throw new V("Graph.dropDirectedEdge: it does not make sense to try and drop a directed edge by key. What if the edge with this key is undirected? Use #.dropEdge for this purpose instead.");if(this.multi)throw new V("Graph.dropDirectedEdge: cannot use a {source,target} combo when dropping an edge in a MultiGraph since we cannot infer the one you want to delete as there could be multiple ones.");a=""+a,t=""+t;let e=ye(this,a,t,"directed");if(!e)throw new B(`Graph.dropDirectedEdge: could not find a "${a}" -> "${t}" edge in the graph.`);return rt(this,e),this}dropUndirectedEdge(a,t){if(arguments.length<2)throw new V("Graph.dropUndirectedEdge: it does not make sense to drop a directed edge by key. What if the edge with this key is undirected? Use #.dropEdge for this purpose instead.");if(this.multi)throw new V("Graph.dropUndirectedEdge: cannot use a {source,target} combo when dropping an edge in a MultiGraph since we cannot infer the one you want to delete as there could be multiple ones.");let e=ye(this,a,t,"undirected");if(!e)throw new B(`Graph.dropUndirectedEdge: could not find a "${a}" -> "${t}" edge in the graph.`);return rt(this,e),this}clear(){this._edges.clear(),this._nodes.clear(),this._resetInstanceCounters(),this.emit("cleared")}clearEdges(){let a=this._nodes.values(),t;for(;t=a.next(),t.done!==!0;)t.value.clear();this._edges.clear(),this._resetInstanceCounters(),this.emit("edgesCleared")}getAttribute(a){return this._attributes[a]}getAttributes(){return this._attributes}hasAttribute(a){return this._attributes.hasOwnProperty(a)}setAttribute(a,t){return this._attributes[a]=t,this.emit("attributesUpdated",{type:"set",attributes:this._attributes,name:a}),this}updateAttribute(a,t){if(typeof t!="function")throw new U("Graph.updateAttribute: updater should be a function.");let e=this._attributes[a];return this._attributes[a]=t(e),this.emit("attributesUpdated",{type:"set",attributes:this._attributes,name:a}),this}removeAttribute(a){return delete this._attributes[a],this.emit("attributesUpdated",{type:"remove",attributes:this._attributes,name:a}),this}replaceAttributes(a){if(!le(a))throw new U("Graph.replaceAttributes: provided attributes are not a plain object.");return this._attributes=a,this.emit("attributesUpdated",{type:"replace",attributes:this._attributes}),this}mergeAttributes(a){if(!le(a))throw new U("Graph.mergeAttributes: provided attributes are not a plain object.");return oe(this._attributes,a),this.emit("attributesUpdated",{type:"merge",attributes:this._attributes,data:a}),this}updateAttributes(a){if(typeof a!="function")throw new U("Graph.updateAttributes: provided updater is not a function.");return this._attributes=a(this._attributes),this.emit("attributesUpdated",{type:"update",attributes:this._attributes}),this}updateEachNodeAttributes(a,t){if(typeof a!="function")throw new U("Graph.updateEachNodeAttributes: expecting an updater function.");if(t&&!Ka(t))throw new U("Graph.updateEachNodeAttributes: invalid hints. Expecting an object having the following shape: {attributes?: [string]}");let e=this._nodes.values(),r,i;for(;r=e.next(),r.done!==!0;)i=r.value,i.attributes=a(i.key,i.attributes);this.emit("eachNodeAttributesUpdated",{hints:t||null})}updateEachEdgeAttributes(a,t){if(typeof a!="function")throw new U("Graph.updateEachEdgeAttributes: expecting an updater function.");if(t&&!Ka(t))throw new U("Graph.updateEachEdgeAttributes: invalid hints. Expecting an object having the following shape: {attributes?: [string]}");let e=this._edges.values(),r,i,o,s;for(;r=e.next(),r.done!==!0;)i=r.value,o=i.source,s=i.target,i.attributes=a(i.key,i.attributes,o.key,s.key,o.attributes,s.attributes,i.undirected);this.emit("eachEdgeAttributesUpdated",{hints:t||null})}forEachAdjacencyEntry(a){if(typeof a!="function")throw new U("Graph.forEachAdjacencyEntry: expecting a callback.");Kt(!1,!1,!1,this,a)}forEachAdjacencyEntryWithOrphans(a){if(typeof a!="function")throw new U("Graph.forEachAdjacencyEntryWithOrphans: expecting a callback.");Kt(!1,!1,!0,this,a)}forEachAssymetricAdjacencyEntry(a){if(typeof a!="function")throw new U("Graph.forEachAssymetricAdjacencyEntry: expecting a callback.");Kt(!1,!0,!1,this,a)}forEachAssymetricAdjacencyEntryWithOrphans(a){if(typeof a!="function")throw new U("Graph.forEachAssymetricAdjacencyEntryWithOrphans: expecting a callback.");Kt(!1,!0,!0,this,a)}nodes(){return Array.from(this._nodes.keys())}forEachNode(a){if(typeof a!="function")throw new U("Graph.forEachNode: expecting a callback.");let t=this._nodes.values(),e,r;for(;e=t.next(),e.done!==!0;)r=e.value,a(r.key,r.attributes)}findNode(a){if(typeof a!="function")throw new U("Graph.findNode: expecting a callback.");let t=this._nodes.values(),e,r;for(;e=t.next(),e.done!==!0;)if(r=e.value,a(r.key,r.attributes))return r.key}mapNodes(a){if(typeof a!="function")throw new U("Graph.mapNode: expecting a callback.");let t=this._nodes.values(),e,r,i=new Array(this.order),o=0;for(;e=t.next(),e.done!==!0;)r=e.value,i[o++]=a(r.key,r.attributes);return i}someNode(a){if(typeof a!="function")throw new U("Graph.someNode: expecting a callback.");let t=this._nodes.values(),e,r;for(;e=t.next(),e.done!==!0;)if(r=e.value,a(r.key,r.attributes))return!0;return!1}everyNode(a){if(typeof a!="function")throw new U("Graph.everyNode: expecting a callback.");let t=this._nodes.values(),e,r;for(;e=t.next(),e.done!==!0;)if(r=e.value,!a(r.key,r.attributes))return!1;return!0}filterNodes(a){if(typeof a!="function")throw new U("Graph.filterNodes: expecting a callback.");let t=this._nodes.values(),e,r,i=[];for(;e=t.next(),e.done!==!0;)r=e.value,a(r.key,r.attributes)&&i.push(r.key);return i}reduceNodes(a,t){if(typeof a!="function")throw new U("Graph.reduceNodes: expecting a callback.");if(arguments.length<2)throw new U("Graph.reduceNodes: missing initial value. You must provide it because the callback takes more than one argument and we cannot infer the initial value from the first iteration, as you could with a simple array.");let e=t,r=this._nodes.values(),i,o;for(;i=r.next(),i.done!==!0;)o=i.value,e=a(e,o.key,o.attributes);return e}nodeEntries(){let a=this._nodes.values();return{[Symbol.iterator](){return this},next(){let t=a.next();if(t.done)return t;let e=t.value;return{value:{node:e.key,attributes:e.attributes},done:!1}}}}export(){let a=new Array(this._nodes.size),t=0;this._nodes.forEach((r,i)=>{a[t++]=Vs(i,r)});let e=new Array(this._edges.size);return t=0,this._edges.forEach((r,i)=>{e[t++]=js(this.type,i,r)}),{options:{type:this.type,multi:this.multi,allowSelfLoops:this.allowSelfLoops},attributes:this.getAttributes(),nodes:a,edges:e}}import(a,t=!1){if(a instanceof n)return a.forEachNode((l,u)=>{t?this.mergeNode(l,u):this.addNode(l,u)}),a.forEachEdge((l,u,d,h,c,f,g)=>{t?g?this.mergeUndirectedEdgeWithKey(l,d,h,u):this.mergeDirectedEdgeWithKey(l,d,h,u):g?this.addUndirectedEdgeWithKey(l,d,h,u):this.addDirectedEdgeWithKey(l,d,h,u)}),this;if(!le(a))throw new U("Graph.import: invalid argument. Expecting a serialized graph or, alternatively, a Graph instance.");if(a.attributes){if(!le(a.attributes))throw new U("Graph.import: invalid attributes. Expecting a plain object.");t?this.mergeAttributes(a.attributes):this.replaceAttributes(a.attributes)}let e,r,i,o,s;if(a.nodes){if(i=a.nodes,!Array.isArray(i))throw new U("Graph.import: invalid nodes. Expecting an array.");for(e=0,r=i.length;e<r;e++){o=i[e],Xs(o);let{key:l,attributes:u}=o;t?this.mergeNode(l,u):this.addNode(l,u)}}if(a.edges){let l=!1;if(this.type==="undirected"&&(l=!0),i=a.edges,!Array.isArray(i))throw new U("Graph.import: invalid edges. Expecting an array.");for(e=0,r=i.length;e<r;e++){s=i[e],qs(s);let{source:u,target:d,attributes:h,undirected:c=l}=s,f;"key"in s?(f=t?c?this.mergeUndirectedEdgeWithKey:this.mergeDirectedEdgeWithKey:c?this.addUndirectedEdgeWithKey:this.addDirectedEdgeWithKey,f.call(this,s.key,u,d,h)):(f=t?c?this.mergeUndirectedEdge:this.mergeDirectedEdge:c?this.addUndirectedEdge:this.addDirectedEdge,f.call(this,u,d,h))}}return this}nullCopy(a){let t=new n(oe({},this._options,a));return t.replaceAttributes(oe({},this.getAttributes())),t}emptyCopy(a){let t=this.nullCopy(a);return this._nodes.forEach((e,r)=>{let i=oe({},e.attributes);e=new t.NodeDataClass(r,i),t._nodes.set(r,e)}),t}copy(a){if(a=a||{},typeof a.type=="string"&&a.type!==this.type&&a.type!=="mixed")throw new V(`Graph.copy: cannot create an incompatible copy from "${this.type}" type to "${a.type}" because this would mean losing information about the current graph.`);if(typeof a.multi=="boolean"&&a.multi!==this.multi&&a.multi!==!0)throw new V("Graph.copy: cannot create an incompatible copy by downgrading a multi graph to a simple one because this would mean losing information about the current graph.");if(typeof a.allowSelfLoops=="boolean"&&a.allowSelfLoops!==this.allowSelfLoops&&a.allowSelfLoops!==!0)throw new V("Graph.copy: cannot create an incompatible copy from a graph allowing self loops to one that does not because this would mean losing information about the current graph.");let t=this.emptyCopy(a),e=this._edges.values(),r,i;for(;r=e.next(),r.done!==!0;)i=r.value,lr(t,"copy",!1,i.undirected,i.key,i.source.key,i.target.key,oe({},i.attributes));return t}toJSON(){return this.export()}toString(){return"[object Graph]"}inspect(){let a={};this._nodes.forEach((i,o)=>{a[o]=i.attributes});let t={},e={};this._edges.forEach((i,o)=>{let s=i.undirected?"--":"->",l="",u=i.source.key,d=i.target.key,h;i.undirected&&u>d&&(h=u,u=d,d=h);let c=`(${u})${s}(${d})`;o.startsWith("geid_")?this.multi&&(typeof e[c]>"u"?e[c]=0:e[c]++,l+=`${e[c]}. `):l+=`[${o}]: `,l+=c,t[l]=i.attributes});let r={};for(let i in this)this.hasOwnProperty(i)&&!Za.has(i)&&typeof this[i]!="function"&&typeof i!="symbol"&&(r[i]=this[i]);return r.attributes=this._attributes,r.nodes=a,r.edges=t,me(r,"constructor",this.constructor),r}};typeof Symbol<"u"&&(ee.prototype[Symbol.for("nodejs.util.inspect.custom")]=ee.prototype.inspect);Zs.forEach(n=>{["add","merge","update"].forEach(a=>{let t=n.name(a),e=a==="add"?lr:el;n.generateKey?ee.prototype[t]=function(r,i,o){return e(this,t,!0,(n.type||this.type)==="undirected",null,r,i,o,a==="update")}:ee.prototype[t]=function(r,i,o,s){return e(this,t,!1,(n.type||this.type)==="undirected",r,i,o,s,a==="update")}})});us(ee);xs(ee);Gs(ee);$s(ee);var Zt=class extends ee{constructor(a){let t=oe({type:"directed"},a);if("multi"in t&&t.multi!==!1)throw new U("DirectedGraph.from: inconsistent indication that the graph should be multi in given options!");if(t.type!=="directed")throw new U('DirectedGraph.from: inconsistent "'+t.type+'" type in given options!');super(t)}},Qt=class extends ee{constructor(a){let t=oe({type:"undirected"},a);if("multi"in t&&t.multi!==!1)throw new U("UndirectedGraph.from: inconsistent indication that the graph should be multi in given options!");if(t.type!=="undirected")throw new U('UndirectedGraph.from: inconsistent "'+t.type+'" type in given options!');super(t)}},Jt=class extends ee{constructor(a){let t=oe({multi:!0},a);if("multi"in t&&t.multi!==!0)throw new U("MultiGraph.from: inconsistent indication that the graph should be simple in given options!");super(t)}},en=class extends ee{constructor(a){let t=oe({type:"directed",multi:!0},a);if("multi"in t&&t.multi!==!0)throw new U("MultiDirectedGraph.from: inconsistent indication that the graph should be simple in given options!");if(t.type!=="directed")throw new U('MultiDirectedGraph.from: inconsistent "'+t.type+'" type in given options!');super(t)}},tn=class extends ee{constructor(a){let t=oe({type:"undirected",multi:!0},a);if("multi"in t&&t.multi!==!0)throw new U("MultiUndirectedGraph.from: inconsistent indication that the graph should be simple in given options!");if(t.type!=="undirected")throw new U('MultiUndirectedGraph.from: inconsistent "'+t.type+'" type in given options!');super(t)}};function st(n){n.from=function(a,t){let e=oe({},a.options,t),r=new n(e);return r.import(a),r}}st(ee);st(Zt);st(Qt);st(Jt);st(en);st(tn);ee.Graph=ee;ee.DirectedGraph=Zt;ee.UndirectedGraph=Qt;ee.MultiGraph=Jt;ee.MultiDirectedGraph=en;ee.MultiUndirectedGraph=tn;ee.InvalidArgumentsGraphError=U;ee.NotFoundGraphError=B;ee.UsageGraphError=V;function on(n,a){(a==null||a>n.length)&&(a=n.length);for(var t=0,e=Array(a);t<a;t++)e[t]=n[t];return e}function sn(n,a){if(n){if(typeof n=="string")return on(n,a);var t={}.toString.call(n).slice(8,-1);return t==="Object"&&n.constructor&&(t=n.constructor.name),t==="Map"||t==="Set"?Array.from(n):t==="Arguments"||/^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(t)?on(n,a):void 0}}function tl(n){if(Array.isArray(n))return n}function nl(n,a){var t=n==null?null:typeof Symbol<"u"&&n[Symbol.iterator]||n["@@iterator"];if(t!=null){var e,r,i,o,s=[],l=!0,u=!1;try{if(i=(t=t.call(n)).next,a===0){if(Object(t)!==t)return;l=!1}else for(;!(l=(e=i.call(t)).done)&&(s.push(e.value),s.length!==a);l=!0);}catch(d){u=!0,r=d}finally{try{if(!l&&t.return!=null&&(o=t.return(),Object(o)!==o))return}finally{if(u)throw r}}return s}}function al(){throw new TypeError(`Invalid attempt to destructure non-iterable instance.
In order to be iterable, non-array objects must have a [Symbol.iterator]() method.`)}function Q(n,a){return tl(n)||nl(n,a)||sn(n,a)||al()}function z(n,a){var t=typeof Symbol<"u"&&n[Symbol.iterator]||n["@@iterator"];if(!t){if(Array.isArray(n)||(t=sn(n))||a&&n&&typeof n.length=="number"){t&&(n=t);var e=0,r=function(){};return{s:r,n:function(){return e>=n.length?{done:!0}:{done:!1,value:n[e++]}},e:function(l){throw l},f:r}}throw new TypeError(`Invalid attempt to iterate non-iterable instance.
In order to be iterable, non-array objects must have a [Symbol.iterator]() method.`)}var i,o=!0,s=!1;return{s:function(){t=t.call(n)},n:function(){var l=t.next();return o=l.done,l},e:function(l){s=!0,i=l},f:function(){try{o||t.return==null||t.return()}finally{if(s)throw i}}}}function be(){return Float32Array.of(1,0,0,0,1,0,0,0,1)}function an(n,a,t){return n[0]=a,n[4]=typeof t=="number"?t:a,n}function ur(n,a){var t=Math.sin(a),e=Math.cos(a);return n[0]=e,n[1]=t,n[3]=-t,n[4]=e,n}function dr(n,a,t){return n[6]=a,n[7]=t,n}function Ge(n,a){var t=n[0],e=n[1],r=n[2],i=n[3],o=n[4],s=n[5],l=n[6],u=n[7],d=n[8],h=a[0],c=a[1],f=a[2],g=a[3],m=a[4],p=a[5],v=a[6],y=a[7],b=a[8];return n[0]=h*t+c*i+f*l,n[1]=h*e+c*o+f*u,n[2]=h*r+c*s+f*d,n[3]=g*t+m*i+p*l,n[4]=g*e+m*o+p*u,n[5]=g*r+m*s+p*d,n[6]=v*t+y*i+b*l,n[7]=v*e+y*o+b*u,n[8]=v*r+y*s+b*d,n}function qn(n,a){var t=Math.cos(a),e=Math.sin(a);return{x:t*n.x+e*n.y,y:-e*n.x+t*n.y}}function ut(n,a){var t=arguments.length>2&&arguments[2]!==void 0?arguments[2]:1,e=n[0],r=n[1],i=n[3],o=n[4],s=n[6],l=n[7],u=a.x,d=a.y;return{x:u*e+d*i+s*t,y:u*r+d*o+l*t}}function rl(n,a){var t=n.height/n.width,e=a.height/a.width;return t<1&&e>1||t>1&&e<1?1:Math.min(Math.max(e,1/e),Math.max(1/t,t))}function Me(n,a,t,e,r){var i=n.angle,o=n.ratio,s=n.x,l=n.y,u=a.width,d=a.height,h=be(),c=Math.min(u,d)-2*e,f=rl(a,t);return r?(Ge(h,dr(be(),s,l)),Ge(h,an(be(),o)),Ge(h,ur(be(),i)),Ge(h,an(be(),u/c/2/f,d/c/2/f))):(Ge(h,an(be(),2*(c/u)*f,2*(c/d)*f)),Ge(h,ur(be(),-i)),Ge(h,an(be(),1/o)),Ge(h,dr(be(),-s,-l))),h}function hr(n,a,t){var e=ut(n,{x:Math.cos(a.angle),y:Math.sin(a.angle)},0),r=e.x,i=e.y;return 1/Math.sqrt(Math.pow(r,2)+Math.pow(i,2))/t.width}function Yn(n,a,t,e,r){var i=Math.floor(a/r*e),o=Math.floor(n.drawingBufferHeight/r-t/r*e);return[i,o]}var Pt={"\x62\x6c\x61\x63\x6b":"#000000","\x73\x69\x6c\x76\x65\x72":"#C0C0C0","\x67\x72\x61\x79":"#808080","\x67\x72\x65\x79":"#808080","\x77\x68\x69\x74\x65":"#FFFFFF","\x6d\x61\x72\x6f\x6f\x6e":"#800000","\x72\x65\x64":"#FF0000","\x70\x75\x72\x70\x6c\x65":"#800080","\x66\x75\x63\x68\x73\x69\x61":"#FF00FF","\x67\x72\x65\x65\x6e":"#008000","\x6c\x69\x6d\x65":"#00FF00","\x6f\x6c\x69\x76\x65":"#808000","\x79\x65\x6c\x6c\x6f\x77":"#FFFF00","\x6e\x61\x76\x79":"#000080","\x62\x6c\x75\x65":"#0000FF","\x74\x65\x61\x6c":"#008080","\x61\x71\x75\x61":"#00FFFF","\x64\x61\x72\x6b\x62\x6c\x75\x65":"#00008B","\x6d\x65\x64\x69\x75\x6d\x62\x6c\x75\x65":"#0000CD","\x64\x61\x72\x6b\x67\x72\x65\x65\x6e":"#006400","\x64\x61\x72\x6b\x63\x79\x61\x6e":"#008B8B","\x64\x65\x65\x70\x73\x6b\x79\x62\x6c\x75\x65":"#00BFFF","\x64\x61\x72\x6b\x74\x75\x72\x71\x75\x6f\x69\x73\x65":"#00CED1","\x6d\x65\x64\x69\x75\x6d\x73\x70\x72\x69\x6e\x67\x67\x72\x65\x65\x6e":"#00FA9A","\x73\x70\x72\x69\x6e\x67\x67\x72\x65\x65\x6e":"#00FF7F","\x63\x79\x61\x6e":"#00FFFF","\x6d\x69\x64\x6e\x69\x67\x68\x74\x62\x6c\x75\x65":"#191970","\x64\x6f\x64\x67\x65\x72\x62\x6c\x75\x65":"#1E90FF","\x6c\x69\x67\x68\x74\x73\x65\x61\x67\x72\x65\x65\x6e":"#20B2AA","\x66\x6f\x72\x65\x73\x74\x67\x72\x65\x65\x6e":"#228B22","\x73\x65\x61\x67\x72\x65\x65\x6e":"#2E8B57","\x64\x61\x72\x6b\x73\x6c\x61\x74\x65\x67\x72\x61\x79":"#2F4F4F","\x64\x61\x72\x6b\x73\x6c\x61\x74\x65\x67\x72\x65\x79":"#2F4F4F","\x6c\x69\x6d\x65\x67\x72\x65\x65\x6e":"#32CD32","\x6d\x65\x64\x69\x75\x6d\x73\x65\x61\x67\x72\x65\x65\x6e":"#3CB371","\x74\x75\x72\x71\x75\x6f\x69\x73\x65":"#40E0D0","\x72\x6f\x79\x61\x6c\x62\x6c\x75\x65":"#4169E1","\x73\x74\x65\x65\x6c\x62\x6c\x75\x65":"#4682B4","\x64\x61\x72\x6b\x73\x6c\x61\x74\x65\x62\x6c\x75\x65":"#483D8B","\x6d\x65\x64\x69\x75\x6d\x74\x75\x72\x71\x75\x6f\x69\x73\x65":"#48D1CC","\x69\x6e\x64\x69\x67\x6f":"#4B0082","\x64\x61\x72\x6b\x6f\x6c\x69\x76\x65\x67\x72\x65\x65\x6e":"#556B2F","\x63\x61\x64\x65\x74\x62\x6c\x75\x65":"#5F9EA0","\x63\x6f\x72\x6e\x66\x6c\x6f\x77\x65\x72\x62\x6c\x75\x65":"#6495ED","\x72\x65\x62\x65\x63\x63\x61\x70\x75\x72\x70\x6c\x65":"#663399","\x6d\x65\x64\x69\x75\x6d\x61\x71\x75\x61\x6d\x61\x72\x69\x6e\x65":"#66CDAA","\x64\x69\x6d\x67\x72\x61\x79":"#696969","\x64\x69\x6d\x67\x72\x65\x79":"#696969","\x73\x6c\x61\x74\x65\x62\x6c\x75\x65":"#6A5ACD","\x6f\x6c\x69\x76\x65\x64\x72\x61\x62":"#6B8E23","\x73\x6c\x61\x74\x65\x67\x72\x61\x79":"#708090","\x73\x6c\x61\x74\x65\x67\x72\x65\x79":"#708090","\x6c\x69\x67\x68\x74\x73\x6c\x61\x74\x65\x67\x72\x61\x79":"#778899","\x6c\x69\x67\x68\x74\x73\x6c\x61\x74\x65\x67\x72\x65\x79":"#778899","\x6d\x65\x64\x69\x75\x6d\x73\x6c\x61\x74\x65\x62\x6c\x75\x65":"#7B68EE","\x6c\x61\x77\x6e\x67\x72\x65\x65\x6e":"#7CFC00","\x63\x68\x61\x72\x74\x72\x65\x75\x73\x65":"#7FFF00","\x61\x71\x75\x61\x6d\x61\x72\x69\x6e\x65":"#7FFFD4","\x73\x6b\x79\x62\x6c\x75\x65":"#87CEEB","\x6c\x69\x67\x68\x74\x73\x6b\x79\x62\x6c\x75\x65":"#87CEFA","\x62\x6c\x75\x65\x76\x69\x6f\x6c\x65\x74":"#8A2BE2","\x64\x61\x72\x6b\x72\x65\x64":"#8B0000","\x64\x61\x72\x6b\x6d\x61\x67\x65\x6e\x74\x61":"#8B008B","\x73\x61\x64\x64\x6c\x65\x62\x72\x6f\x77\x6e":"#8B4513","\x64\x61\x72\x6b\x73\x65\x61\x67\x72\x65\x65\x6e":"#8FBC8F","\x6c\x69\x67\x68\x74\x67\x72\x65\x65\x6e":"#90EE90","\x6d\x65\x64\x69\x75\x6d\x70\x75\x72\x70\x6c\x65":"#9370DB","\x64\x61\x72\x6b\x76\x69\x6f\x6c\x65\x74":"#9400D3","\x70\x61\x6c\x65\x67\x72\x65\x65\x6e":"#98FB98","\x64\x61\x72\x6b\x6f\x72\x63\x68\x69\x64":"#9932CC","\x79\x65\x6c\x6c\x6f\x77\x67\x72\x65\x65\x6e":"#9ACD32","\x73\x69\x65\x6e\x6e\x61":"#A0522D","\x62\x72\x6f\x77\x6e":"#A52A2A","\x64\x61\x72\x6b\x67\x72\x61\x79":"#A9A9A9","\x64\x61\x72\x6b\x67\x72\x65\x79":"#A9A9A9","\x6c\x69\x67\x68\x74\x62\x6c\x75\x65":"#ADD8E6","\x67\x72\x65\x65\x6e\x79\x65\x6c\x6c\x6f\x77":"#ADFF2F","\x70\x61\x6c\x65\x74\x75\x72\x71\x75\x6f\x69\x73\x65":"#AFEEEE","\x6c\x69\x67\x68\x74\x73\x74\x65\x65\x6c\x62\x6c\x75\x65":"#B0C4DE","\x70\x6f\x77\x64\x65\x72\x62\x6c\x75\x65":"#B0E0E6","\x66\x69\x72\x65\x62\x72\x69\x63\x6b":"#B22222","\x64\x61\x72\x6b\x67\x6f\x6c\x64\x65\x6e\x72\x6f\x64":"#B8860B","\x6d\x65\x64\x69\x75\x6d\x6f\x72\x63\x68\x69\x64":"#BA55D3","\x72\x6f\x73\x79\x62\x72\x6f\x77\x6e":"#BC8F8F","\x64\x61\x72\x6b\x6b\x68\x61\x6b\x69":"#BDB76B","\x6d\x65\x64\x69\x75\x6d\x76\x69\x6f\x6c\x65\x74\x72\x65\x64":"#C71585","\x69\x6e\x64\x69\x61\x6e\x72\x65\x64":"#CD5C5C","\x70\x65\x72\x75":"#CD853F","\x63\x68\x6f\x63\x6f\x6c\x61\x74\x65":"#D2691E","\x74\x61\x6e":"#D2B48C","\x6c\x69\x67\x68\x74\x67\x72\x61\x79":"#D3D3D3","\x6c\x69\x67\x68\x74\x67\x72\x65\x79":"#D3D3D3","\x74\x68\x69\x73\x74\x6c\x65":"#D8BFD8","\x6f\x72\x63\x68\x69\x64":"#DA70D6","\x67\x6f\x6c\x64\x65\x6e\x72\x6f\x64":"#DAA520","\x70\x61\x6c\x65\x76\x69\x6f\x6c\x65\x74\x72\x65\x64":"#DB7093","\x63\x72\x69\x6d\x73\x6f\x6e":"#DC143C","\x67\x61\x69\x6e\x73\x62\x6f\x72\x6f":"#DCDCDC","\x70\x6c\x75\x6d":"#DDA0DD","\x62\x75\x72\x6c\x79\x77\x6f\x6f\x64":"#DEB887","\x6c\x69\x67\x68\x74\x63\x79\x61\x6e":"#E0FFFF","\x6c\x61\x76\x65\x6e\x64\x65\x72":"#E6E6FA","\x64\x61\x72\x6b\x73\x61\x6c\x6d\x6f\x6e":"#E9967A","\x76\x69\x6f\x6c\x65\x74":"#EE82EE","\x70\x61\x6c\x65\x67\x6f\x6c\x64\x65\x6e\x72\x6f\x64":"#EEE8AA","\x6c\x69\x67\x68\x74\x63\x6f\x72\x61\x6c":"#F08080","\x6b\x68\x61\x6b\x69":"#F0E68C","\x61\x6c\x69\x63\x65\x62\x6c\x75\x65":"#F0F8FF","\x68\x6f\x6e\x65\x79\x64\x65\x77":"#F0FFF0","\x61\x7a\x75\x72\x65":"#F0FFFF","\x73\x61\x6e\x64\x79\x62\x72\x6f\x77\x6e":"#F4A460","\x77\x68\x65\x61\x74":"#F5DEB3","\x62\x65\x69\x67\x65":"#F5F5DC","\x77\x68\x69\x74\x65\x73\x6d\x6f\x6b\x65":"#F5F5F5","\x6d\x69\x6e\x74\x63\x72\x65\x61\x6d":"#F5FFFA","\x67\x68\x6f\x73\x74\x77\x68\x69\x74\x65":"#F8F8FF","\x73\x61\x6c\x6d\x6f\x6e":"#FA8072","\x61\x6e\x74\x69\x71\x75\x65\x77\x68\x69\x74\x65":"#FAEBD7","\x6c\x69\x6e\x65\x6e":"#FAF0E6","\x6c\x69\x67\x68\x74\x67\x6f\x6c\x64\x65\x6e\x72\x6f\x64\x79\x65\x6c\x6c\x6f\x77":"#FAFAD2","\x6f\x6c\x64\x6c\x61\x63\x65":"#FDF5E6","\x6d\x61\x67\x65\x6e\x74\x61":"#FF00FF","\x64\x65\x65\x70\x70\x69\x6e\x6b":"#FF1493","\x6f\x72\x61\x6e\x67\x65\x72\x65\x64":"#FF4500","\x74\x6f\x6d\x61\x74\x6f":"#FF6347","\x68\x6f\x74\x70\x69\x6e\x6b":"#FF69B4","\x63\x6f\x72\x61\x6c":"#FF7F50","\x64\x61\x72\x6b\x6f\x72\x61\x6e\x67\x65":"#FF8C00","\x6c\x69\x67\x68\x74\x73\x61\x6c\x6d\x6f\x6e":"#FFA07A","\x6f\x72\x61\x6e\x67\x65":"#FFA500","\x6c\x69\x67\x68\x74\x70\x69\x6e\x6b":"#FFB6C1","\x70\x69\x6e\x6b":"#FFC0CB","\x67\x6f\x6c\x64":"#FFD700","\x70\x65\x61\x63\x68\x70\x75\x66\x66":"#FFDAB9","\x6e\x61\x76\x61\x6a\x6f\x77\x68\x69\x74\x65":"#FFDEAD","\x6d\x6f\x63\x63\x61\x73\x69\x6e":"#FFE4B5","\x62\x69\x73\x71\x75\x65":"#FFE4C4","\x6d\x69\x73\x74\x79\x72\x6f\x73\x65":"#FFE4E1","\x62\x6c\x61\x6e\x63\x68\x65\x64\x61\x6c\x6d\x6f\x6e\x64":"#FFEBCD","\x70\x61\x70\x61\x79\x61\x77\x68\x69\x70":"#FFEFD5","\x6c\x61\x76\x65\x6e\x64\x65\x72\x62\x6c\x75\x73\x68":"#FFF0F5","\x73\x65\x61\x73\x68\x65\x6c\x6c":"#FFF5EE","\x63\x6f\x72\x6e\x73\x69\x6c\x6b":"#FFF8DC","\x6c\x65\x6d\x6f\x6e\x63\x68\x69\x66\x66\x6f\x6e":"#FFFACD","\x66\x6c\x6f\x72\x61\x6c\x77\x68\x69\x74\x65":"#FFFAF0","\x73\x6e\x6f\x77":"#FFFAFA","\x6c\x69\x67\x68\x74\x79\x65\x6c\x6c\x6f\x77":"#FFFFE0","\x69\x76\x6f\x72\x79":"#FFFFF0"},cr=new Int8Array(4),rn=new Int32Array(cr.buffer,0,1),fr=new Float32Array(cr.buffer,0,1),il=/^\s*rgba?\s*\(/,ol=/^\s*rgba?\s*\(\s*([0-9]*)\s*,\s*([0-9]*)\s*,\s*([0-9]*)(?:\s*,\s*(.*)?)?\)\s*$/;function ln(n){var a=0,t=0,e=0,r=1,i=n.toLowerCase();if(i==="transparent")return{r:0,g:0,b:0,a:0};if(i in Pt)return ln(Pt[i]);if(n[0]==="#")n.length===4?(a=parseInt(n.charAt(1)+n.charAt(1),16),t=parseInt(n.charAt(2)+n.charAt(2),16),e=parseInt(n.charAt(3)+n.charAt(3),16)):(a=parseInt(n.charAt(1)+n.charAt(2),16),t=parseInt(n.charAt(3)+n.charAt(4),16),e=parseInt(n.charAt(5)+n.charAt(6),16)),n.length===9&&(r=parseInt(n.charAt(7)+n.charAt(8),16)/255);else if(il.test(n)){var o=n.match(ol);o&&(a=+o[1],t=+o[2],e=+o[3],o[4]&&(r=+o[4]))}return{r:a,g:t,b:e,a:r}}function gr(n){var a=arguments.length>1&&arguments[1]!==void 0?arguments[1]:!1,t=ln(n),e=t.r,r=t.g,i=t.b,o=t.a;return a?[e/255*o,r/255*o,i/255*o,o]:[e/255,r/255,i/255,o]}var lt={};for(kt in Pt)lt[kt]=xe(Pt[kt]),lt[Pt[kt]]=lt[kt];var kt;function sl(n,a,t,e,r){return rn[0]=e<<24|t<<16|a<<8|n,r&&(rn[0]=rn[0]&4278190079),fr[0]}function xe(n){if(n=n.toLowerCase(),typeof lt[n]<"u")return lt[n];var a=ln(n),t=a.r,e=a.g,r=a.b,i=a.a;i=i*255|0;var o=sl(t,e,r,i,!0);return lt[n]=o,o}function ze(n,a){fr[0]=xe(n);var t=rn[0];a&&(t=t|16777216);var e=t&255,r=t>>8&255,i=t>>16&255,o=t>>24&255;return[e,r,i,o]}function dt(n){var a=n>>>8&255,t=n>>>16&255,e=n>>>24&255,r=n&255;return(r<<24|e<<16|t<<8|a)>>>0}function Kn(n,a,t,e){return(t<<24|a<<16|n<<8|e)>>>0}function vr(n,a,t,e,r,i){var o=Yn(n,t,e,r,i),s=Q(o,2),l=s[0],u=s[1],d=new Uint8Array(4);n.bindFramebuffer(n.FRAMEBUFFER,a),n.readPixels(l,u,1,1,n.RGBA,n.UNSIGNED_BYTE,d);var h=Q(d,4),c=h[0],f=h[1],g=h[2],m=h[3];return[c,f,g,m]}function pr(n){var a=ln(n),t=a.r,e=a.g,r=a.b,i=a.a,o=(t/255).toFixed(6),s=(e/255).toFixed(6),l=(r/255).toFixed(6),u=i.toFixed(6);return"vec4(".concat(o,", ").concat(s,", ").concat(l,", ").concat(u,")")}function ll(n,a){if(typeof n!="object"||!n)return n;var t=n[Symbol.toPrimitive];if(t!==void 0){var e=t.call(n,a||"default");if(typeof e!="object")return e;throw new TypeError("@@toPrimitive must return a primitive value.")}return(a==="string"?String:Number)(n)}function br(n){var a=ll(n,"string");return typeof a=="symbol"?a:a+""}function E(n,a,t){return(a=br(a))in n?Object.defineProperty(n,a,{value:t,enumerable:!0,configurable:!0,writable:!0}):n[a]=t,n}function mr(n,a){var t=Object.keys(n);if(Object.getOwnPropertySymbols){var e=Object.getOwnPropertySymbols(n);a&&(e=e.filter(function(r){return Object.getOwnPropertyDescriptor(n,r).enumerable})),t.push.apply(t,e)}return t}function W(n){for(var a=1;a<arguments.length;a++){var t=arguments[a]!=null?arguments[a]:{};a%2?mr(Object(t),!0).forEach(function(e){E(n,e,t[e])}):Object.getOwnPropertyDescriptors?Object.defineProperties(n,Object.getOwnPropertyDescriptors(t)):mr(Object(t)).forEach(function(e){Object.defineProperty(n,e,Object.getOwnPropertyDescriptor(t,e))})}return n}function Y(n,a){if(!(n instanceof a))throw new TypeError("Cannot call a class as a function")}function yr(n,a){for(var t=0;t<a.length;t++){var e=a[t];e.enumerable=e.enumerable||!1,e.configurable=!0,"value"in e&&(e.writable=!0),Object.defineProperty(n,br(e.key),e)}}function K(n,a,t){return a&&yr(n.prototype,a),t&&yr(n,t),Object.defineProperty(n,"prototype",{writable:!1}),n}function je(n){return je=Object.setPrototypeOf?Object.getPrototypeOf.bind():function(a){return a.__proto__||Object.getPrototypeOf(a)},je(n)}function xr(){try{var n=!Boolean.prototype.valueOf.call(Reflect.construct(Boolean,[],function(){}))}catch{}return(xr=function(){return!!n})()}function ul(n){if(n===void 0)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return n}function dl(n,a){if(a&&(typeof a=="object"||typeof a=="function"))return a;if(a!==void 0)throw new TypeError("Derived constructors may only return object or undefined");return ul(n)}function te(n,a,t){return a=je(a),dl(n,xr()?Reflect.construct(a,t||[],je(n).constructor):a.apply(n,t))}function Zn(n,a){return Zn=Object.setPrototypeOf?Object.setPrototypeOf.bind():function(t,e){return t.__proto__=e,t},Zn(n,a)}function ne(n,a){if(typeof a!="function"&&a!==null)throw new TypeError("Super expression must either be null or a function");n.prototype=Object.create(a&&a.prototype,{constructor:{value:n,writable:!0,configurable:!0}}),Object.defineProperty(n,"prototype",{writable:!1}),a&&Zn(n,a)}function hl(n){if(Array.isArray(n))return on(n)}function cl(n){if(typeof Symbol<"u"&&n[Symbol.iterator]!=null||n["@@iterator"]!=null)return Array.from(n)}function fl(){throw new TypeError(`Invalid attempt to spread non-iterable instance.
In order to be iterable, non-array objects must have a [Symbol.iterator]() method.`)}function $(n){return hl(n)||cl(n)||sn(n)||fl()}function Z(n){"@babel/helpers - typeof";return Z=typeof Symbol=="function"&&typeof Symbol.iterator=="symbol"?function(a){return typeof a}:function(a){return a&&typeof Symbol=="function"&&a.constructor===Symbol&&a!==Symbol.prototype?"symbol":typeof a},Z(n)}function Fe(n){return Z(n)==="object"&&n!==null&&"attribute"in n}function _r(){var n=`
float sdf_circle(vec2 uv, float size) {
  return length(uv) - size;
}
`;return{name:"circle",glsl:n,uniforms:[]}}function Tr(n){var a,t=WebGL2RenderingContext,e=t.UNSIGNED_BYTE,r=(a=n?.color)!==null&&a!==void 0?a:{attribute:"color"};if(!Fe(r)){var i=r,o=`
vec4 layer_fill() {
  return `.concat(pr(i),`;
}
`);return{name:"fill",uniforms:[],attributes:[],glsl:o}}var s=r.attribute,l=`
vec4 layer_fill(vec4 v_fillColor) {
  return v_fillColor;
}
`;return{name:"fill",uniforms:[],attributes:[{name:"fillColor",size:4,type:e,normalized:!0,source:s}],glsl:l}}function gl(n,a){if(typeof n=="string"){var t=gr(n).map(function(u){return u.toFixed(6)}),e=Q(t,4),r=e[0],i=e[1],o=e[2],s=e[3];return{glsl:"vec4(".concat(r,", ").concat(i,", ").concat(o,", ").concat(s,")"),attributes:[],needsNodeColors:!1}}if("node"in n&&n.node)return{glsl:n.node==="source"?"v_sourceColor":"v_targetColor",attributes:[],needsNodeColors:!0};var l=n;return{glsl:"v_".concat(a),attributes:[{name:"a_".concat(a),size:4,type:WebGL2RenderingContext.UNSIGNED_BYTE,normalized:!0,source:l.attribute,defaultValue:l.default}],needsNodeColors:!1}}function Xe(n){var a=n?.color;if(a===void 0){var t=`
// Plain solid color layer
vec4 layer_plain(EdgeContext ctx) {
  return v_color;
}
`;return{name:"plain",glsl:t,uniforms:[],attributes:[]}}var e=gl(a,"plainColor"),r=`
// Plain solid color layer
vec4 layer_plain(EdgeContext ctx) {
  return `.concat(e.glsl,`;
}
`);return{name:"plain",glsl:r,uniforms:[],attributes:e.attributes,needsNodeColors:e.needsNodeColors}}function Er(){var n=`
// Position at parameter t \u2208 [0, 1]
vec2 path_straight_position(float t, vec2 source, vec2 target) {
  return mix(source, target, t);
}

// Total length of the path (analytical - more efficient than sampling)
float path_straight_length(vec2 source, vec2 target) {
  return length(target - source);
}
`;return{name:"straight",segments:1,minBodyLengthRatio:0,linearParameterization:!0,glsl:n,uniforms:[],attributes:[]}}function Sr(n){var a=n??{},t=a.segments,e=t===void 0?32:t,r=`
const float LOOP_PI = 3.141592653589793;

float loopWorldRadius() {
  float nodeWorldRadius = v_sourceNodeSize * u_correctionRatio / u_sizeRatio;
  return max(v_loopRadius * nodeWorldRadius, 0.001);
}

// Cubic B\xE9zier with P0 = P3 = source.
// Control points extend outward orthogonal to the node surface at exit/entry angles.
vec2 path_loop_position(float t, vec2 source, vec2 target) {
  float R = loopWorldRadius();
  float angle = v_loopAngle + (v_loopFixedOrientation > 0.5 ? u_cameraAngle : 0.0);
  float halfSpread = v_loopSpread * 0.5;

  float exitAngle = angle - halfSpread;
  float entryAngle = angle + halfSpread;

  // Control point distance: at t=0.5 the B\xE9zier reaches 0.75 * cpDist * cos(halfSpread)
  // from source. Solve for cpDist so the loop tip reaches exactly R.
  float cpDist = R / (0.75 * cos(halfSpread));

  vec2 cp1 = source + cpDist * vec2(cos(exitAngle), sin(exitAngle));
  vec2 cp2 = source + cpDist * vec2(cos(entryAngle), sin(entryAngle));

  float u = 1.0 - t;
  vec2 d1 = cp1 - source;
  vec2 d2 = cp2 - source;
  return source + 3.0 * t * u * (u * d1 + t * d2);
}

// Approximate arc length via chord sampling
float path_loop_length(vec2 source, vec2 target) {
  float len = 0.0;
  vec2 prev = path_loop_position(0.0, source, target);
  const int STEPS = 16;
  for (int i = 1; i <= STEPS; i++) {
    float t = float(i) / float(STEPS);
    vec2 cur = path_loop_position(t, source, target);
    len += length(cur - prev);
    prev = cur;
  }
  return len;
}
`;return{name:"loop",segments:e,glsl:r,needsNodeSize:!0,uniforms:[],attributes:[{name:"loopRadius",size:1,type:WebGL2RenderingContext.FLOAT},{name:"loopAngle",size:1,type:WebGL2RenderingContext.FLOAT},{name:"loopSpread",size:1,type:WebGL2RenderingContext.FLOAT},{name:"loopFixedOrientation",size:1,type:WebGL2RenderingContext.FLOAT}],variables:{loopRadius:{type:"number",default:4},loopAngle:{type:"number",default:Math.PI/4},loopSpread:{type:"number",default:80*Math.PI/180},loopFixedOrientation:{type:"number",default:0}},spread:{variable:"loopRadius",compute:function(o){return o+4}}}}var Lr=Ve(Dt());function Ar(n){return Z(n)==="object"&&"glsl"in n&&!("attributes"in n)}function wr(n){return Z(n)==="object"&&"glsl"in n&&!("attributes"in n)}var Ft={shapes:[_r()],variables:{},layers:[Tr()],label:{},backdrop:{},labelAttachments:{}},ht={paths:[Er(),Sr()],extremities:[],variables:{},layers:[Xe()],defaultHead:"none",defaultTail:"none",label:{}},un=["nodes","topNodes"],dn=["edges","topEdges"],hn=[].concat(dn,un),Dr={nodes:Ft,edges:ht,depthLayers:$(hn)};var vl=function(a){return a},pl=function(a){return a*a},ml=function(a){return a*(2-a)},yl=function(a){return(a*=2)<1?.5*a*a:-.5*(--a*(a-2)-1)},bl=function(a){return a*a*a},xl=function(a){return--a*a*a+1},_l=function(a){return(a*=2)<1?.5*a*a*a:.5*((a-=2)*a*a+2)},Tl=function(a){return a===0?0:Math.pow(2,10*(a-1))},El=function(a){return a===1?1:1-Math.pow(2,-10*a)},Sl=function(a){return a===0?0:a===1?1:a<.5?Math.pow(2,10*(2*a-1))/2:(2-Math.pow(2,-10*(2*a-1)))/2},Qn={linear:vl,quadraticIn:pl,quadraticOut:ml,quadraticInOut:yl,cubicIn:bl,cubicOut:xl,cubicInOut:_l,exponentialIn:Tl,exponentialOut:El,exponentialInOut:Sl};function cn(n){return n?typeof n=="function"?n:Qn[n]:Qn.linear}function ea(n){return Z(n)==="object"&&n!==null&&"attribute"in n}function kr(n){return typeof n=="function"}function Pr(n){return Z(n)==="object"&&n!==null&&"when"in n&&typeof n.when=="function"&&"then"in n}function Fr(n){return Z(n)==="object"&&n!==null&&"whenState"in n&&"then"in n}function Ir(n){return Z(n)==="object"&&n!==null&&"whenData"in n&&"then"in n}var Al={isHovered:!1,isLabelHovered:!1,isHidden:!1,isHighlighted:!1,isDragged:!1},wl={isHovered:!1,isLabelHovered:!1,isHidden:!1,isHighlighted:!1,parallelIndex:0,parallelCount:1},Dl={isIdle:!0,isPanning:!1,isZooming:!1,isDragging:!1,hasHovered:!1,hasHighlighted:!1};function Nr(n){return W(W({},Al),n)}function Gr(n){return W(W({},wl),n)}function ta(n){return W(W({},Dl),n)}var Rl={x:{attribute:"x"},y:{attribute:"y"},size:{whenState:"isHovered",then:{attribute:"size",defaultValue:12},else:{attribute:"size",defaultValue:10}},color:{attribute:"color",defaultValue:"#666"},label:{attribute:"label"},visibility:{whenState:"isHidden",then:"hidden",else:"visible"},labelVisibility:{whenState:"isHovered",then:"visible",else:"auto"},backdropVisibility:{whenState:"isHovered",then:"visible",else:"hidden"},backdropColor:"#ffffff",backdropShadowColor:"rgba(0, 0, 0, 0.5)",backdropShadowBlur:12,backdropPadding:6},Cl={size:{attribute:"size",defaultValue:1},color:{attribute:"color",defaultValue:"#ccc"},label:{attribute:"label"},visibility:{whenState:"isHidden",then:"hidden",else:"visible"}};var gn={nodes:W(W({},Rl),{},{depth:{whenState:"isHovered",then:"topNodes",else:"nodes"}}),edges:W(W({},Cl),{},{depth:{whenState:["isHighlighted","isHovered"],then:"topEdges",else:"edges"}})};function Ll(n){return"min"in n||"max"in n||"minValue"in n||"maxValue"in n||"easing"in n}function kl(n){return"dict"in n}function vn(n,a){return typeof n=="string"?a[n]===!0:Array.isArray(n)?n.every(function(t){return a[t]===!0}):Z(n)==="object"&&n!==null?Object.entries(n).every(function(t){var e=Q(t,2),r=e[0],i=e[1];return a[r]===i}):!1}function Pl(n,a){var t=a[n.attribute];return t===void 0?n.defaultValue:t}function Fl(n,a,t){var e,r,i,o,s=a[n.attribute];if(s===void 0)return n.defaultValue;var l=Number(s);if(isNaN(l))return n.defaultValue;if(n.min===void 0&&n.max===void 0)return l;var u=(e=n.minValue)!==null&&e!==void 0?e:l,d=(r=n.maxValue)!==null&&r!==void 0?r:l;if(d===u){var h;return(h=n.min)!==null&&h!==void 0?h:l}var c=(l-u)/(d-u);c=Math.max(0,Math.min(1,c));var f=cn(n.easing);c=f(c);var g=(i=n.min)!==null&&i!==void 0?i:0,m=(o=n.max)!==null&&o!==void 0?o:1;return g+c*(m-g)}function Il(n,a){var t=a[n.attribute];if(t===void 0)return n.defaultValue;var e=String(t);return e in n.dict?n.dict[e]:n.defaultValue}function Nl(n,a,t){return kl(n)?Il(n,a):Ll(n)?Fl(n,a):Pl(n,a)}function Mr(n,a){return typeof n=="string"?!!a[n]:Array.isArray(n)?n.every(function(t){return!!a[t]}):Z(n)==="object"&&n!==null?Object.entries(n).every(function(t){var e=Q(t,2),r=e[0],i=e[1];return a[r]===i}):!1}function fn(n,a,t,e,r,i){if(n==null)return i;if(Z(n)!=="object"&&typeof n!="function")return n;if(Pr(n)){var o=n.when(a,t,e,r)?n.then:n.else;return o===void 0?i:fn(o,a,t,e,r,i)}if(Fr(n)){var s=vn(n.whenState,t)?n.then:n.else;return s===void 0?i:fn(s,a,t,e,r,i)}if(Ir(n)){var l=Mr(n.whenData,a)?n.then:n.else;return l===void 0?i:fn(l,a,t,e,r,i)}if(kr(n)){var u=n(a,t,e,r);return u??i}if(ea(n)){var d=Nl(n,a);return d??i}return n}function Ae(n){if(n==null)return"static";if(Pr(n))return"graph-state";if(Fr(n)){var a=Ae(n.then),t=n.else!==void 0?Ae(n.else):"static";return _e("item-state",_e(a,t))}if(Ir(n)){var e=Ae(n.then),r=n.else!==void 0?Ae(n.else):"static";return _e(e,r)}return kr(n)?"graph-state":(ea(n),"static")}function _e(n,a){return n==="graph-state"||a==="graph-state"?"graph-state":n==="item-state"||a==="item-state"?"item-state":"static"}function na(n){if(!n)return{dependency:"static",xAttribute:null,yAttribute:null};var a=Array.isArray(n)?n:[n],t="static",e=null,r=null,i=z(a),o;try{for(i.s();!(o=i.n()).done;){var s=o.value;if("matchData"in s&&"cases"in s)for(var l=s.cases,u=0,d=Object.values(l);u<d.length;u++)for(var h=d[u],c=0,f=Object.values(h);c<f.length;c++){var g=f[c];t=_e(t,Ae(g))}else if("matchState"in s&&"cases"in s){t=_e(t,"item-state");for(var m=s.cases,p=0,v=Object.values(m);p<v.length;p++)for(var y=v[p],b=0,T=Object.values(y);b<T.length;b++){var x=T[b];t=_e(t,Ae(x))}}else if("when"in s&&"then"in s)t="graph-state";else if("whenState"in s){t=_e(t,"item-state");var _=s.then;if(_&&Z(_)==="object")for(var S=0,A=Object.values(_);S<A.length;S++){var R=A[S];t=_e(t,Ae(R))}var w=s.else;if(w&&Z(w)==="object")for(var F=0,D=Object.values(w);F<D.length;F++){var I=D[F];t=_e(t,Ae(I))}}else if("whenData"in s){var C=s.then;if(C&&Z(C)==="object")for(var k=0,G=Object.values(C);k<G.length;k++){var N=G[k];t=_e(t,Ae(N))}var L=s.else;if(L&&Z(L)==="object")for(var P=0,M=Object.values(L);P<M.length;P++){var H=M[P];t=_e(t,Ae(H))}}else for(var O=0,q=Object.entries(s);O<q.length;O++){var j=Q(q[O],2),X=j[0],Ee=j[1];if(!ra.has(X)&&(t=_e(t,Ae(Ee)),(X==="x"||X==="y")&&ea(Ee))){var he=Ee.attribute;X==="x"&&!e&&(e=he),X==="y"&&!r&&(r=he)}}}}catch(Le){i.e(Le)}finally{i.f()}return{dependency:t,xAttribute:e,yAttribute:r}}var Ie={size:10,"\x63\x6f\x6c\x6f\x72":"#666",opacity:1,shape:"circle",rotationAlignment:"viewport",labelRotationAlignment:"viewport",visibility:"visible",depth:"nodes",zIndex:0,label:"",labelColor:"#000",labelSize:12,labelFont:"sans-serif",labelVisibility:"auto",labelPosition:"right",labelAngle:0,labelDepth:"nodes",backdropVisibility:"hidden",backdropColor:"transparent",backdropShadowColor:"transparent",backdropShadowBlur:0,backdropPadding:0,backdropBorderColor:"transparent",backdropBorderWidth:0,backdropCornerRadius:0,backdropLabelPadding:-1,backdropArea:"both",labelAttachment:null,labelAttachmentPlacement:"below"},aa={size:1,"\x63\x6f\x6c\x6f\x72":"#ccc",opacity:1,path:"straight",selfLoopPath:"loop",parallelSpread:.25,tail:"none",head:"none",visibility:"visible",depth:"edges",zIndex:0,label:"",labelColor:"#666",labelVisibility:"auto",labelDepth:"edges"},ra=new Set(["when","whenState","whenData","then","else"]),Rr=Object.keys(Ie),Gl=Object.values(Ie),Cr=Object.keys(aa),Ml=Object.values(aa);function ct(n,a,t,e,r,i,o){for(var s in a){var l;if(!ra.has(s)){var u=(l=n[s])!==null&&l!==void 0?l:o[s];n[s]=fn(a[s],t,e,r,i,u)}}"depth"in a&&!("labelDepth"in a)&&(n.labelDepth=n.depth)}function zr(n,a,t,e,r,i,o){var s=z(a),l;try{for(s.s();!(l=s.n()).done;){var u=l.value;if("matchData"in u&&"cases"in u){var d,h=String((d=t[u.matchData])!==null&&d!==void 0?d:""),c=u.cases;h in c&&ct(n,c[h],t,e,r,i,o)}else if("matchState"in u&&"cases"in u){var f,g=String((f=e[u.matchState])!==null&&f!==void 0?f:""),m=u.cases;g in m&&ct(n,m[g],t,e,r,i,o)}else if("when"in u&&"then"in u){var p=u.when;if(!p(t,e,r,i))continue;ct(n,u.then,t,e,r,i,o)}else if("whenState"in u&&"then"in u){if(!vn(u.whenState,e))continue;ct(n,u.then,t,e,r,i,o)}else if("whenData"in u&&"then"in u){if(!Mr(u.whenData,t))continue;ct(n,u.then,t,e,r,i,o)}else ct(n,u,t,e,r,i,o)}}catch(v){s.e(v)}finally{s.f()}}function ia(n,a,t,e,r,i){for(var o=i||{},s=o,l=0,u=Rr.length;l<u;l++)s[Rr[l]]=Gl[l];if(s.x=void 0,s.y=void 0,s.labelBackgroundColor=void 0,s.labelBackgroundPadding=void 0,s.labelCursor=void 0,!n){var d,h,c,f,g;return s.x=(d=a.x)!==null&&d!==void 0?d:0,s.y=(h=a.y)!==null&&h!==void 0?h:0,o.size=(c=a.size)!==null&&c!==void 0?c:10,o.color=(f=a.color)!==null&&f!==void 0?f:"#666",o.label=(g=a.label)!==null&&g!==void 0?g:"",o}var m=Array.isArray(n)?n:[n];return zr(s,m,a,t,e,r,Ie),o}function oa(n,a,t,e,r,i){for(var o=i||{},s=o,l=0,u=Cr.length;l<u;l++)s[Cr[l]]=Ml[l];if(!n){var d,h,c;return o.size=(d=a.size)!==null&&d!==void 0?d:1,o.color=(h=a.color)!==null&&h!==void 0?h:"#ccc",o.label=(c=a.label)!==null&&c!==void 0?c:"",o}var f=Array.isArray(n)?n:[n];return zr(s,f,a,t,e,r,aa),typeof s.labelPosition=="number"&&(s.labelPosition=void 0),o}function zl(n,a,t){var e,r;if(n==null)return t;if(typeof n=="function")return(e=n(a))!==null&&e!==void 0?e:t;if(Z(n)==="object"&&"when"in n){var i,o=n,s=o.when(a),l=s?o.then:o.else;return l===void 0?t:typeof l=="function"?(i=l(a))!==null&&i!==void 0?i:t:l??t}if(Z(n)==="object"&&"whenState"in n){var u,d=n,h=vn(d.whenState,a),c=h?d.then:d.else;return c===void 0?t:typeof c=="function"?(u=c(a))!==null&&u!==void 0?u:t:c??t}return(r=n)!==null&&r!==void 0?r:t}function sa(n,a){var t={};if(!n)return t;var e=Array.isArray(n)?n:[n],r=z(e),i;try{for(r.s();!(i=r.n()).done;){var o=i.value;if("when"in o&&"then"in o){var s=o.when(a),l=s?o.then:o.else;l&&Z(l)==="object"&&Jn(t,l,a)}else if("whenState"in o&&"then"in o){var u=vn(o.whenState,a),d=u?o.then:o.else;d&&Z(d)==="object"&&Jn(t,d,a)}else Jn(t,o,a)}}catch(h){r.e(h)}finally{r.f()}return t}function Jn(n,a,t){for(var e=0,r=Object.entries(a);e<r.length;e++){var i=Q(r[e],2),o=i[0],s=i[1];ra.has(o)||(n[o]=zl(s,t))}}var pn=function(n){function a(){var t;return Y(this,a),t=te(this,a),t.rawEmitter=t,t}return ne(a,n),K(a)}(Lr.EventEmitter);var Wr=Dr;function la(n,a){var t=a.size;if(t!==0){var e=n.length;n.length+=t;var r=0;a.forEach(function(i){n[e+r]=i,r++})}}function Br(n){n=n||{};for(var a=0,t=arguments.length<=1?0:arguments.length-1;a<t;a++){var e=a+1<1||arguments.length<=a+1?void 0:arguments[a+1];e&&Object.assign(n,e)}return n}function ft(n,a){for(var t in a)if(Object.prototype.hasOwnProperty.call(a,t)&&a[t]!==n[t])return!0;return!1}function Ur(n,a){var t=n,e=a;for(var r in t)if(Object.prototype.hasOwnProperty.call(t,r)&&t[r]!==e[r])return!1;for(var i in e)if(Object.prototype.hasOwnProperty.call(e,i)&&e[i]!==t[i])return!1;return!0}function qe(n,a,t){t?n.add(a):n.delete(a)}var Hr=Ve(It());var $r={easing:"quadraticInOut",duration:150};function We(n){return n.labelVisibility==="visible"&&n.visibility!=="hidden"}function ua(n){return n.backdropVisibility==="visible"&&n.visibility!=="hidden"}function mn(n){return[n.rotationAlignment==="graph"?1:0,n.labelRotationAlignment==="graph"?1:0]}function da(n,a,t){var e=n[a];if(e)for(var r=0;r<e.length;r++){var i=e[r];if(!(t<i.offset||t>=i.offset+i.count)){if(i.count===1)e.splice(r,1);else if(t===i.offset)i.offset++,i.count--;else if(t===i.offset+i.count-1)i.count--;else{var o=t+1,s=i.offset+i.count-o;i.count=t-i.offset,e.splice(r+1,0,{offset:o,count:s})}return}}}function ha(n,a,t){if(!n[a]){n[a]=[{offset:t,count:1}];return}for(var e=n[a],r=e.length,i=0;i<e.length;i++)if(t<e[i].offset){r=i;break}var o=r>0?e[r-1]:null,s=r<e.length?e[r]:null,l=o&&o.offset+o.count===t,u=s&&t+1===s.offset;l&&u?(o.count+=1+s.count,e.splice(r,1)):l?o.count++:u?(s.offset--,s.count++):e.splice(r,0,{offset:t,count:1})}function Vr(n){if(!(0,Hr.default)(n))throw new Error("Sigma: invalid graph instance.")}function yn(n){var a=Q(n.x,2),t=a[0],e=a[1],r=Q(n.y,2),i=r[0],o=r[1],s=Math.max(e-t,o-i),l=(e+t)/2,u=(o+i)/2;(s===0||Math.abs(s)===1/0||isNaN(s))&&(s=1),isNaN(l)&&(l=0),isNaN(u)&&(u=0);var d=function(c){return{x:.5+(c.x-l)/s,y:.5+(c.y-u)/s}};return d.applyTo=function(h){h.x=.5+(h.x-l)/s,h.y=.5+(h.y-u)/s},d.inverse=function(h){return{x:l+s*(h.x-.5),y:u+s*(h.y-.5)}},d.ratio=s,d}var bn={hideEdgesOnMove:!1,hideLabelsOnMove:!1,renderLabels:!0,renderEdgeLabels:!1,edgeLabelAnchors:"nodeLabels",enableEdgeEvents:!1,nodeLabelEvents:!1,edgeLabelEvents:!1,pickingDownSizingRatio:2,nodePickingPadding:0,edgePickingPadding:4,labelPickingPadding:10,stagePadding:30,minEdgeThickness:1.7,antiAliasingFeather:1,antialiasEdges:!0,antialiasNodes:!0,dragTimeout:100,draggedEventsTolerance:3,inertiaDuration:200,inertiaRatio:3,zoomDuration:250,zoomingRatio:1.7,doubleClickTimeout:300,doubleClickZoomingRatio:2.2,doubleClickZoomingDuration:200,tapMoveTolerance:10,zoomToSizeRatioFunction:Math.sqrt,itemSizesReference:"positions",autoRescale:!0,autoRescaleContent:"positions",enableNodeDrag:!1,getDraggedNodes:function(a){return[a]},dragPositionToAttributes:null,labelDensity:1,labelGridCellSize:100,labelRenderedSizeThreshold:6,labelPixelSnapping:!0,minCameraRatio:null,maxCameraRatio:null,enableCameraZooming:!0,enableCameraPanning:!0,enableCameraRotation:!0,enableCameraMouseRotation:!0,cameraPanBoundaries:null,gestureTarget:"graph",sharedGestureWheelMessage:"Use Ctrl + scroll to zoom the graph",sharedGestureAppleWheelMessage:"Use \u2318 + scroll to zoom the graph",sharedGestureTouchMessage:"Use two fingers to move the graph",allowInvalidContainer:!1,DEBUG_displayPickingLayer:!1,DEBUG_logShaders:!1,DEBUG_logRenderStats:!1,DEBUG_gpuTimerQueries:!1};function xn(n){if(typeof n.labelDensity!="number"||n.labelDensity<0)throw new Error("Settings: invalid `labelDensity`. Expecting a positive number.");var a=n.minCameraRatio,t=n.maxCameraRatio;if(typeof a=="number"&&typeof t=="number"&&t<a)throw new Error("Settings: invalid camera ratio boundaries. Expecting `maxCameraRatio` to be greater than `minCameraRatio`.")}function jr(n){return Br({},bn,n)}var Wl=new Set(["italic","oblique"]),Bl=new Set(["bold","bolder","lighter"]);function _n(n){for(var a="normal",t="normal",e=n.trim(),r=e.split(/\s+/),i=0,o=0;o<r.length;o++){var s=r[o].toLowerCase();if(Wl.has(s))t=s,i=o+1;else if(Bl.has(s)||/^\d{3}$/.test(s))a=s,i=o+1;else if(s==="normal")i=o+1;else break}var l=r.slice(i).join(" ");return{family:l||e,weight:a,style:t}}function gt(n,a,t){var e=document.createElement(n);if(a)for(var r in a)e.style[r]=a[r];if(t)for(var i in t)e.setAttribute(i,t[i]);return e}function Nt(){return typeof window.devicePixelRatio<"u"?window.devicePixelRatio:1}var ni=Ve(Dt());function Ul(n){var a=n.type===WebGL2RenderingContext.FLOAT&&!n.normalized,t=n.type===WebGL2RenderingContext.UNSIGNED_BYTE&&n.size===4&&n.normalized;if(!a&&!t)throw new Error('Attribute "'.concat(n.name,'" is invalid: only non-normalized FLOAT and normalized UNSIGNED_BYTE with size 4 are supported.'));return n.normalized?1:n.size}function ca(n){var a=0;return n.forEach(function(t){return a+=Ul(t)}),a}function ai(n,a,t){var e=n==="VERTEX"?a.VERTEX_SHADER:a.FRAGMENT_SHADER,r=a.createShader(e);if(r===null)throw new Error("loadShader: error while creating the shader");a.shaderSource(r,t),a.compileShader(r);var i=a.getShaderParameter(r,a.COMPILE_STATUS);if(!i){var o=a.getShaderInfoLog(r);throw a.deleteShader(r),new Error(`loadShader: error while compiling the shader:
`.concat(o,`
`).concat(t))}return r}function ga(n,a){return ai("VERTEX",n,a)}function va(n,a){return ai("FRAGMENT",n,a)}function pa(n,a){var t=n.createProgram();if(t===null)throw new Error("loadProgram: error while creating the program.");var e,r;for(e=0,r=a.length;e<r;e++)n.attachShader(t,a[e]);n.linkProgram(t);var i=n.getProgramParameter(t,n.LINK_STATUS);if(!i){var o=n.getProgramInfoLog(t);throw n.deleteProgram(t),new Error("loadProgram: error while linking the program: ".concat(o))}return t}function Xr(n){var a=n.gl,t=n.buffer,e=n.program,r=n.vertexShader,i=n.fragmentShader;a.deleteShader(r),a.deleteShader(i),a.deleteProgram(e),a.deleteBuffer(t)}function re(n){return n%1===0?n.toFixed(1):n.toString()}var Dn=new Map,ri=new Map,Ol=0;function ii(n,a){var t,e=(t=n.variables)===null||t===void 0||(t=t[a.source||a.name.replace(/^a_/,"")])===null||t===void 0?void 0:t.default,r=typeof e=="number"?e:typeof a.defaultValue=="number"?a.defaultValue:0;return re(r)}function Rn(n,a,t){var e,r=arguments.length>3&&arguments[3]!==void 0?arguments[3]:function(o){return"v_".concat(o.name.replace(/^a_/,""))},i=[a,t].concat($(n.uniforms.filter(function(o){return o.type==="float"}).map(function(o){var s;return re((s=o.value)!==null&&s!==void 0?s:0)})),$(((e=n.attributes)!==null&&e!==void 0?e:[]).map(r)));return"sdf_".concat(n.name,"(").concat(i.join(", "),")")}function Hl(n){var a,t=n.name,e=n.uniforms.filter(function(o){return o.type==="float"&&o.value!==void 0&&o.value!==0}).map(function(o){return"".concat(o.name.replace("u_",""),"=").concat(o.value)}).sort(),r=((a=n.attributes)!==null&&a!==void 0?a:[]).map(function(o){var s;return"".concat(o.name,"@").concat((s=o.source)!==null&&s!==void 0?s:"","=").concat(ii(n,o))}),i=[].concat($(e),$(r));return i.length>0&&(t+="#"+i.join("#")),t}function $l(n){var a=Hl(n);if(!Dn.has(a)){var t={},e=z(n.uniforms),r;try{for(e.s();!(r=e.n()).done;){var i=r.value;i.type==="float"&&i.value!==void 0&&(t[i.name]=i.value)}}catch(o){e.e(o)}finally{e.f()}Dn.set(a,{shape:n,uniformValues:t,slug:a}),ri.set(a,Ol++)}return a}function Bt(n){var a;return(a=ri.get(n))!==null&&a!==void 0?a:-1}function oi(n){var a=[],t=new Set,e=new Set,r=/mat2 rotate2D\(float angle\)\s*\{[^}]+\}/,i=z(n),o;try{for(i.s();!(o=i.n()).done;){var s=o.value;if(!e.has(s.name)){e.add(s.name);var l=s.glsl;r.test(l)&&(t.has("rotate2D")?l=l.replace(r,""):t.add("rotate2D")),a.push(l)}}}catch(u){i.e(u)}finally{i.f()}return a.join(`
`)}function Vl(){return oi(Array.from(Dn.values()).map(function(n){return n.shape}))}function jl(n){var a=Array.from(Dn.entries());if(a.length===0)return`
float querySDF(int shapeId, vec2 uv, float size) {
  return length(uv) - size;
}
`;var t=a.map(function(e,r){var i=Q(e,2),o=i[0],s=i[1].shape,l=Rn(s,"uv","size",function(u){var d=u.name.replace(/^a_/,"");return n!=null&&n.has(d)?"g_".concat(d):ii(s,u)});return"    case ".concat(r,": return ").concat(l,"; // ").concat(o)}).join(`
`);return`
float querySDF(int shapeId, vec2 uv, float size) {
  switch (shapeId) {
`.concat(t,`
    default: return length(uv) - size;
  }
}
`)}function ma(n){return oi(n)}function Ut(n){return $(new Map(n.flatMap(function(a){return a.uniforms}).map(function(a){return[a.name,a]})).values())}function Xl(n,a){if(n.length===0)return`
void queryNodeSDF(int shapeId, vec2 uv, float size) {
  context.sdf = length(uv) - size;
  context.inradiusFactor = 1.0;
}
`;var t=function(h){return Rn(h,"uv","size")},e=function(h){var c,f;return(c=h.inradiusFactorGLSL)!==null&&c!==void 0?c:re((f=h.inradiusFactor)!==null&&f!==void 0?f:1)};if(n.length===1){var r=n[0];return`
void queryNodeSDF(int shapeId, vec2 uv, float size) {
  context.sdf = `.concat(t(r),`;
  context.inradiusFactor = `).concat(e(r),`;
}
`)}var i=n.map(function(d,h){return"    case ".concat(h,": // ").concat(d.name,`
      context.sdf = `).concat(t(d),`;
      context.inradiusFactor = `).concat(e(d),`;
      break;`)}).join(`
`),o=n[0],s="",l="shapeId";if(a&&a.length>1){var u=a.map(function(d,h){return"    case ".concat(d,": return ").concat(h,"; // ").concat(n[h].name)}).join(`
`);s=`
int globalToLocalShapeId(int globalId) {
  switch (globalId) {
`.concat(u,`
    default: return 0;
  }
}
`),l="globalToLocalShapeId(shapeId)"}return"".concat(s,`
void queryNodeSDF(int shapeId, vec2 uv, float size) {
  switch (`).concat(l,`) {
`).concat(i,`
    default:
      context.sdf = `).concat(t(o),`;
      context.inradiusFactor = `).concat(e(o),`;
  }
}
`)}var pt={right:0,left:1,above:2,below:3,over:4},mt=5,ya=3,si=`
float matrixScaleX = length(vec2(u_matrix[0][0], u_matrix[1][0]));
float nodeRadiusGraphSpace = nodeSize * u_correctionRatio / u_sizeRatio * 2.0;
float nodeRadiusNDC = nodeRadiusGraphSpace * matrixScaleX;
float nodeRadiusPixels = nodeRadiusNDC * u_resolution.x / 2.0;
`,ql=`
mat2 rotate2D(float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return mat2(c, -s, s, c);
}
`,li=`
vec2 getLabelDirection(float positionMode) {
  if (positionMode < 0.5) return vec2(1.0, 0.0);   // Right
  if (positionMode < 1.5) return vec2(-1.0, 0.0);  // Left
  if (positionMode < 2.5) return vec2(0.0, -1.0);  // Above
  if (positionMode < 3.5) return vec2(0.0, 1.0);   // Below
  return vec2(0.0);                                 // Over (centered)
}
`,Yl=`
float sdfBox(vec2 p, vec2 halfSize) {
  vec2 d = abs(p) - halfSize;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
`,Kl=`
float sdfRotatedBox(vec2 p, vec2 halfSize, float angle) {
  float c = cos(-angle);
  float s = sin(-angle);
  vec2 rotatedP = mat2(c, -s, s, c) * p;
  return sdfBox(rotatedP, halfSize);
}
`,Zl=`
float sdfRoundedBox(vec2 p, vec2 halfSize, float radius) {
  vec2 d = abs(p) - halfSize + radius;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - radius;
}
`,Ql=`
float sdfRoundedRotatedBox(vec2 p, vec2 halfSize, float angle, float radius) {
  float c = cos(-angle);
  float s = sin(-angle);
  vec2 rotatedP = mat2(c, -s, s, c) * p;
  return sdfRoundedBox(rotatedP, halfSize, radius);
}
`,ui=`
vec2 labelBoxCenter(float positionMode, float labelStart, vec2 halfSize, float textHalfY) {
  if (positionMode < 0.5) return vec2(labelStart + halfSize.x, 0.0);    // right
  if (positionMode < 1.5) return vec2(-(labelStart + halfSize.x), 0.0); // left
  if (positionMode < 2.5) return vec2(0.0, -(labelStart + textHalfY));  // above
  if (positionMode < 3.5) return vec2(0.0, labelStart + textHalfY);     // below
  return vec2(0.0);                                                     // over
}
`,ba=2,Ne=`
vec4 readNodeData(sampler2D nodeDataTexture, int nodeDataTextureWidth, int nodeIndex) {
  int t = nodeIndex * `.concat(ba,`;
  ivec2 coord = ivec2(t % nodeDataTextureWidth, t / nodeDataTextureWidth);
  return texelFetch(nodeDataTexture, coord, 0);
}
`),Ke=`
vec4 readNodeFlags(sampler2D nodeDataTexture, int nodeDataTextureWidth, int nodeIndex) {
  int t = nodeIndex * `.concat(ba,` + 1;
  ivec2 coord = ivec2(t % nodeDataTextureWidth, t / nodeDataTextureWidth);
  return texelFetch(nodeDataTexture, coord, 0);
}
`),Jl=`
vec4 readNodeColor(sampler2D nodeDataTexture, int nodeDataTextureWidth, int nodeIndex) {
  int t = nodeIndex * `.concat(ba,` + 1;
  ivec2 coord = ivec2(t % nodeDataTextureWidth, t / nodeDataTextureWidth);
  vec4 texel = texelFetch(nodeDataTexture, coord, 0);
  float r = floor(texel.b / 65536.0);
  float g = floor(mod(texel.b, 65536.0) / 256.0);
  float b = mod(texel.b, 256.0);
  return vec4(r / 255.0, g / 255.0, b / 255.0, texel.a);
}
`),yt=`
vec4 readFrameTexel(sampler2D frameTexture, int frameTextureWidth, int index) {
  ivec2 coord = ivec2(index % frameTextureWidth, index / frameTextureWidth);
  return texelFetch(frameTexture, coord, 0);
}
`;function eu(n,a){var t=function(o){return Rn(o,"uv","size")};if(n.length===1)return{code:qr(t(n[0])),multiShape:!1};var e=n.map(function(i,o){return"    case ".concat(a?a[o]:o,": return ").concat(t(i),";")}).join(`
`),r=`
float queryShapeSDF(int shapeId, vec2 uv, float size) {
  switch (shapeId) {
`.concat(e,`
    default: return `).concat(t(n[0]),`;
  }
}
int g_shapeId;
`).concat(qr("queryShapeSDF(g_shapeId, uv, size)"),`
`);return{code:r,multiShape:!0}}function qr(n){return`
float findEdgeDistance(vec2 direction, float size) {
  float lo = 0.0, hi = 2.0;
  for (int i = 0; i < 8; i++) {
    float mid = (lo + hi) * 0.5;
    vec2 uv = direction * mid;
    if (`.concat(n,` < 0.0) lo = mid; else hi = mid;
  }
  return (lo + hi) * 0.5;
}
`)}function tu(n,a){for(;!{}.hasOwnProperty.call(n,a)&&(n=je(n))!==null;);return n}function fa(){return fa=typeof Reflect<"u"&&Reflect.get?Reflect.get.bind():function(n,a,t){var e=tu(n,a);if(e){var r=Object.getOwnPropertyDescriptor(e,a);return r.get?r.get.call(arguments.length<3?n:t):r.value}},fa.apply(null,arguments)}function se(n,a,t,e){var r=fa(je(1&e?n.prototype:n),a,t);return 2&e&&typeof r=="function"?function(i){return r.apply(t,i)}:r}var nu=1024,au=1.5,ru=4096,di=-1,Cn=function(){function n(a,t){var e=arguments.length>2&&arguments[2]!==void 0?arguments[2]:nu;Y(this,n),E(this,"texture",null),E(this,"dirty",!1),E(this,"dirtyRangeStart",1/0),E(this,"dirtyRangeEnd",-1),E(this,"indexMap",new Map),E(this,"freeIndices",[]),E(this,"nextIndex",0),this.gl=a,this.TEXELS_PER_ITEM=t,this.capacity=this.roundUpToPowerOfTwo(e);var r=this.computeTextureDimensions(this.capacity);this.textureWidth=r.width,this.textureHeight=r.height,this.data=new Float32Array(this.textureWidth*this.textureHeight*4),this.createTexture()}return K(n,[{key:"computeTextureDimensions",value:function(t){var e=t*this.TEXELS_PER_ITEM,r=Math.min(e,ru),i=Math.ceil(e/r);return{width:r,height:i}}},{key:"roundUpToPowerOfTwo",value:function(t){return Math.pow(2,Math.ceil(Math.log2(Math.max(1,t))))}},{key:"createTexture",value:function(){var t=this.gl;this.texture=t.createTexture(),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_2D,this.texture),t.texImage2D(t.TEXTURE_2D,0,t.RGBA32F,this.textureWidth,this.textureHeight,0,t.RGBA,t.FLOAT,this.data),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.NEAREST),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.NEAREST),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),t.bindTexture(t.TEXTURE_2D,null)}},{key:"resize",value:function(t){if(!(t<=this.capacity)){var e=this.roundUpToPowerOfTwo(Math.ceil(t*au)),r=this.gl,i=this.computeTextureDimensions(e),o=new Float32Array(i.width*i.height*4);o.set(this.data),this.texture&&r.deleteTexture(this.texture),this.data=o,this.capacity=e,this.textureWidth=i.width,this.textureHeight=i.height,this.createTexture(),this.dirty=!0,this.dirtyRangeStart=0,this.dirtyRangeEnd=this.nextIndex}}},{key:"allocate",value:function(t){var e=this.indexMap.get(t);if(e!==void 0)return e;var r;return this.freeIndices.length>0?r=this.freeIndices.pop():(r=this.nextIndex++,r>=this.capacity&&this.resize(r+1)),this.indexMap.set(t,r),r}},{key:"free",value:function(t){var e=this.indexMap.get(t);if(e!==void 0){this.indexMap.delete(t),this.freeIndices.push(e);for(var r=e*this.TEXELS_PER_ITEM*4,i=0;i<this.TEXELS_PER_ITEM*4;i++)this.data[r+i]=0;this.markDirty(e)}}},{key:"getIndex",value:function(t){var e;return(e=this.indexMap.get(t))!==null&&e!==void 0?e:-1}},{key:"has",value:function(t){return this.indexMap.has(t)}},{key:"markDirty",value:function(t){this.dirty=!0,this.dirtyRangeStart=Math.min(this.dirtyRangeStart,t),this.dirtyRangeEnd=Math.max(this.dirtyRangeEnd,t+1)}},{key:"upload",value:function(){if(!(!this.dirty||!this.texture)){var t=this.gl,e=this.textureWidth;t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_2D,this.texture);var r=this.dirtyRangeStart*this.TEXELS_PER_ITEM,i=Math.min(this.dirtyRangeEnd*this.TEXELS_PER_ITEM,this.capacity*this.TEXELS_PER_ITEM);if(r<i)for(var o=Math.floor(r/e),s=Math.floor((i-1)/e),l=o;l<=s;l++){var u=l*e,d=Math.min(u+e,this.capacity*this.TEXELS_PER_ITEM),h=Math.max(r,u),c=Math.min(i,d);if(h<c){var f=h-u,g=c-h,m=this.data.subarray(h*4,c*4);t.texSubImage2D(t.TEXTURE_2D,0,f,l,g,1,t.RGBA,t.FLOAT,m)}}t.bindTexture(t.TEXTURE_2D,null),this.dirty=!1,this.dirtyRangeStart=1/0,this.dirtyRangeEnd=-1}}},{key:"bind",value:function(t){var e=this.gl;e.activeTexture(e.TEXTURE0+t),e.bindTexture(e.TEXTURE_2D,this.texture)}},{key:"getTexture",value:function(){return this.texture}},{key:"getCapacity",value:function(){return this.capacity}},{key:"getTextureWidth",value:function(){return this.textureWidth}},{key:"getTextureHeight",value:function(){return this.textureHeight}},{key:"getTexelsPerItem",value:function(){return this.TEXELS_PER_ITEM}},{key:"getCount",value:function(){return this.indexMap.size}},{key:"getHighWaterMark",value:function(){return this.nextIndex}},{key:"isDirty",value:function(){return this.dirty}},{key:"clear",value:function(){this.indexMap.clear(),this.freeIndices=[],this.nextIndex=0,this.data.fill(0),this.dirty=!0,this.dirtyRangeStart=0,this.dirtyRangeEnd=this.capacity}},{key:"restore",value:function(){this.createTexture(),this.dirty=!1,this.dirtyRangeStart=1/0,this.dirtyRangeEnd=-1}},{key:"kill",value:function(){this.texture&&(this.gl.deleteTexture(this.texture),this.texture=null),this.indexMap.clear(),this.freeIndices=[]}}])}();function Te(n){var a={},t={},e=0,r=z(n),i;try{for(r.s();!(i=r.n()).done;){var o=i.value,s=z(o.attributes),l;try{for(s.s();!(l=s.n()).done;){var u=l.value,d=u.name.replace(/^a_/,"");d in a||(a[d]=e,t[d]=u,e+=u.size)}}catch(h){s.e(h)}finally{s.f()}}}catch(h){r.e(h)}finally{r.f()}return{floatsPerItem:e,texelsPerItem:Math.max(1,Math.ceil(e/4)),offsets:a,specs:t}}var Ln=function(n){function a(t,e,r){var i;return Y(this,a),i=te(this,a,[t,e.texelsPerItem,r]),i.floatsPerItem=e.floatsPerItem,i}return ne(a,n),K(a,[{key:"updateAllAttributes",value:function(e,r){var i=this.indexMap.get(e);i===void 0&&(i=this.allocate(e));for(var o=i*this.TEXELS_PER_ITEM*4,s=Math.min(r.length,this.floatsPerItem),l=0;l<s;l++)this.data[o+l]=r[l];this.markDirty(i)}},{key:"updateAllAttributesAtRow",value:function(e,r){e>=this.capacity&&this.resize(e+1);for(var i=e*this.TEXELS_PER_ITEM*4,o=Math.min(r.length,this.floatsPerItem),s=0;s<o;s++)this.data[i+s]=r[s];this.markDirty(e)}}])}(Cn);function kn(n,a,t){for(var e=[],r=new Set,i=0;i<n.length;i++){var o=n[i],s=z(o.attributes),l;try{for(s.s();!(l=s.n()).done;){var u=l.value,d=u.name.replace(/^a_/,"");if(!r.has(d)){r.add(d);var h=a.offsets[d];if(h!==void 0){var c=t?.get(i);e.push({sourceKey:u.source||d,packedOffset:h,size:u.size,isColor:u.size===4&&!!u.normalized,defaultNum:typeof u.defaultValue=="number"?u.defaultValue:u.defaultValue===!0?1:0,defaultColor:typeof u.defaultValue=="string"?u.defaultValue:"",sourceIndex:i,hasLifecycleHook:!!(c!=null&&c.getAttributeData)})}}}}catch(f){s.e(f)}finally{s.f()}}return e}function Pn(n,a,t,e,r,i){t.fill(0);for(var o=0,s=n.length;o<s;o++){var l=n[o],u=l.packedOffset,d=void 0;if(l.hasLifecycleHook){var h=r.get(l.sourceIndex-i);d=h.getAttributeData(a,l.sourceKey),d===null&&(d=a[l.sourceKey])}else d=a[l.sourceKey];if(l.isColor){var c=typeof d=="string"?d:l.defaultColor||e,f=ze(c),g=Q(f,4),m=g[0],p=g[1],v=g[2],y=g[3];t[u]=m/255,t[u+1]=p/255,t[u+2]=v/255,t[u+3]=y/255}else if(l.size===1)t[u]=typeof d=="number"?d:typeof d=="boolean"?d?1:0:l.defaultNum;else{var b=Array.isArray(d)?d:null;if(b)for(var T=0;T<l.size;T++){var x;t[u+T]=(x=b[T])!==null&&x!==void 0?x:0}}}}var Tn=["r","g","b","a"];function vt(n,a){var t=n.offsets,e=n.specs,r=n.texelsPerItem,i=n.floatsPerItem,o=Object.keys(t);if(o.length===0||i===0)return{fetchCode:"",varyingAssignments:""};var s=a.varPrefix,l=a.baseTexelExpr,u=a.textureWidthUniform,d=a.textureSamplerUniform,h=a.outputPrefix,c=h===void 0?"v_":h,f=[];f.push("  int ".concat(s,"BaseTexel = ").concat(l,";")),f.push("");for(var g=0;g<r;g++)f.push("  ivec2 ".concat(s,"Coord").concat(g," = ivec2((").concat(s,"BaseTexel + ").concat(g,") % ").concat(u,", (").concat(s,"BaseTexel + ").concat(g,") / ").concat(u,");")),f.push("  vec4 ".concat(s,"Texel").concat(g," = texelFetch(").concat(d,", ").concat(s,"Coord").concat(g,", 0);"));f.push("");for(var m=[],p=function(){var T=y[v],x=e[T],_=t[T],S=Math.floor(_/4),A=_%4,R="".concat(s,"Texel").concat(S),w="".concat(s,"Texel").concat(S+1),F="".concat(s,"Fetched_").concat(T);if(x.size===1)f.push("  float ".concat(F," = ").concat(R,".").concat(Tn[A],";"));else if(x.size===4&&A===0)f.push("  vec4 ".concat(F," = ").concat(R,";"));else{var D=A+x.size;if(D<=4){var I="vec".concat(x.size),C=Tn.slice(A,D).join("");f.push("  ".concat(I," ").concat(F," = ").concat(R,".").concat(C,";"))}else{var k=x.size===4?"vec4":"vec".concat(x.size),G=Tn.slice(A).map(function(P){return"".concat(R,".").concat(P)}),N=Tn.slice(0,D-4).map(function(P){return"".concat(w,".").concat(P)}),L=[].concat($(G),$(N)).join(", ");f.push("  ".concat(k," ").concat(F," = ").concat(k,"(").concat(L,");"))}}m.push("  ".concat(c).concat(T," = ").concat(F,";"))},v=0,y=o;v<y.length;v++)p();return{fetchCode:f.join(`
`),varyingAssignments:m.join(`
`)}}function xa(n,a,t){if(!(!a||t.type==="sampler2D"))switch(t.type){case"float":n.uniform1f(a,t.value);break;case"int":case"bool":n.uniform1i(a,t.value);break;case"vec2":n.uniform2fv(a,t.value);break;case"vec3":n.uniform3fv(a,t.value);break;case"vec4":n.uniform4fv(a,t.value);break;case"mat3":n.uniformMatrix3fv(a,!1,t.value);break;case"mat4":n.uniformMatrix4fv(a,!1,t.value);break}}var iu=E(E(E(E(E(E(E(E({},WebGL2RenderingContext.BOOL,1),WebGL2RenderingContext.BYTE,1),WebGL2RenderingContext.UNSIGNED_BYTE,1),WebGL2RenderingContext.SHORT,2),WebGL2RenderingContext.UNSIGNED_SHORT,2),WebGL2RenderingContext.INT,4),WebGL2RenderingContext.UNSIGNED_INT,4),WebGL2RenderingContext.FLOAT,4);function En(n){var a=n.match(/^(#version[^\n]*\n)/);return a?a[1]+`#define PICKING_MODE
`+n.slice(a[1].length):`#define PICKING_MODE
`+n}var Ze=function(){function n(a,t,e){Y(this,n),E(this,"floats",new Float32Array),E(this,"ints",new Uint32Array),E(this,"constantArray",new Float32Array),E(this,"capacity",0),E(this,"verticesCount",0),E(this,"bufferGeneration",0),E(this,"uploadedGeneration",new Map),E(this,"constantBufferGeneration",0),E(this,"uploadedConstantGeneration",new Map),E(this,"renderOffset",0),E(this,"renderCount",-1),E(this,"debugStats",{drawCalls:0,verticesDrawn:0,bufferUploadBytes:0}),E(this,"shadersLogged",!1),E(this,"pickProgram",null);var r=this.getDefinition();if(this.VERTICES=r.VERTICES,this.VERTEX_SHADER_SOURCE=r.VERTEX_SHADER_SOURCE,this.FRAGMENT_SHADER_SOURCE=r.FRAGMENT_SHADER_SOURCE,this.UNIFORMS=r.UNIFORMS,this.ATTRIBUTES=r.ATTRIBUTES,this.METHOD=r.METHOD,this.CONSTANT_ATTRIBUTES="CONSTANT_ATTRIBUTES"in r?r.CONSTANT_ATTRIBUTES:[],this.CONSTANT_DATA="CONSTANT_DATA"in r?r.CONSTANT_DATA:[],this.isInstanced="CONSTANT_ATTRIBUTES"in r,this.ATTRIBUTES_ITEMS_COUNT=ca(this.ATTRIBUTES),this.STRIDE=this.VERTICES*this.ATTRIBUTES_ITEMS_COUNT,this.renderer=e,this.normalProgram=this.getProgramInfo("normal",a,r.VERTEX_SHADER_SOURCE,r.FRAGMENT_SHADER_SOURCE,null),this.pickProgram=this.getProgramInfo("pick",a,En(r.VERTEX_SHADER_SOURCE),En(r.FRAGMENT_SHADER_SOURCE),null),this.isInstanced){var i=ca(this.CONSTANT_ATTRIBUTES);if(this.CONSTANT_DATA.length!==this.VERTICES)throw new Error("Program: error while getting constant data (expected ".concat(this.VERTICES," items, received ").concat(this.CONSTANT_DATA.length," instead)"));this.constantArray=new Float32Array(this.CONSTANT_DATA.length*i);for(var o=0;o<this.CONSTANT_DATA.length;o++){var s=this.CONSTANT_DATA[o];if(s.length!==i)throw new Error("Program: error while getting constant data (one vector has ".concat(s.length," items instead of ").concat(i,")"));for(var l=0;l<s.length;l++)this.constantArray[o*i+l]=s[l]}this.STRIDE=this.ATTRIBUTES_ITEMS_COUNT}}return K(n,[{key:"kill",value:function(){Xr(this.normalProgram),this.pickProgram&&Xr(this.pickProgram)}},{key:"resetDebugStats",value:function(){this.debugStats.drawCalls=0,this.debugStats.verticesDrawn=0,this.debugStats.bufferUploadBytes=0}},{key:"getProgramInfo",value:function(t,e,r,i,o){var s=e.createBuffer();if(s===null)throw new Error("Program: error while creating the WebGL buffer.");var l=ga(e,r),u=va(e,i),d=pa(e,[l,u]),h={};this.UNIFORMS.forEach(function(g){var m=e.getUniformLocation(d,g);m&&(h[g]=m)});var c={};this.ATTRIBUTES.forEach(function(g){c[g.name]=e.getAttribLocation(d,g.name)});var f;if(this.isInstanced&&(this.CONSTANT_ATTRIBUTES.forEach(function(g){c[g.name]=e.getAttribLocation(d,g.name)}),f=e.createBuffer(),f===null))throw new Error("Program: error while creating the WebGL constant buffer.");return{name:t,program:d,gl:e,frameBuffer:o,buffer:s,constantBuffer:f||{},uniformLocations:h,attributeLocations:c,isPicking:t==="pick",vertexShader:l,fragmentShader:u}}},{key:"bindProgram",value:function(t){var e=this,r=0,i=t.gl,o=t.buffer;if(this.isInstanced){if(i.bindBuffer(i.ARRAY_BUFFER,t.constantBuffer),r=0,this.CONSTANT_ATTRIBUTES.forEach(function(d){return r+=e.bindAttribute(d,t,r,!1)}),this.uploadedConstantGeneration.get(t.constantBuffer)!==this.constantBufferGeneration){var l;i.bufferData(i.ARRAY_BUFFER,this.constantArray,i.STATIC_DRAW),this.uploadedConstantGeneration.set(t.constantBuffer,this.constantBufferGeneration),(l=this.renderer)!==null&&l!==void 0&&l.getSetting("DEBUG_logRenderStats")&&(this.debugStats.bufferUploadBytes+=this.constantArray.byteLength)}if(i.bindBuffer(i.ARRAY_BUFFER,t.buffer),r=this.renderOffset*this.ATTRIBUTES_ITEMS_COUNT*Float32Array.BYTES_PER_ELEMENT,this.ATTRIBUTES.forEach(function(d){return r+=e.bindAttribute(d,t,r,!0)}),this.uploadedGeneration.get(o)!==this.bufferGeneration){var u;i.bufferData(i.ARRAY_BUFFER,this.floats,i.DYNAMIC_DRAW),this.uploadedGeneration.set(o,this.bufferGeneration),(u=this.renderer)!==null&&u!==void 0&&u.getSetting("DEBUG_logRenderStats")&&(this.debugStats.bufferUploadBytes+=this.floats.byteLength)}}else if(i.bindBuffer(i.ARRAY_BUFFER,o),r=0,this.ATTRIBUTES.forEach(function(d){return r+=e.bindAttribute(d,t,r)}),this.uploadedGeneration.get(o)!==this.bufferGeneration){var s;i.bufferData(i.ARRAY_BUFFER,this.floats,i.DYNAMIC_DRAW),this.uploadedGeneration.set(o,this.bufferGeneration),(s=this.renderer)!==null&&s!==void 0&&s.getSetting("DEBUG_logRenderStats")&&(this.debugStats.bufferUploadBytes+=this.floats.byteLength)}i.bindBuffer(i.ARRAY_BUFFER,null)}},{key:"unbindProgram",value:function(t){var e=this;this.isInstanced?(this.CONSTANT_ATTRIBUTES.forEach(function(r){return e.unbindAttribute(r,t,!1)}),this.ATTRIBUTES.forEach(function(r){return e.unbindAttribute(r,t,!0)})):this.ATTRIBUTES.forEach(function(r){return e.unbindAttribute(r,t)})}},{key:"bindAttribute",value:function(t,e,r,i){var o=iu[t.type];if(typeof o!="number")throw new Error('Program.bind: yet unsupported attribute type "'.concat(t.type,'"'));var s=e.attributeLocations[t.name],l=e.gl;if(s!==-1){l.enableVertexAttribArray(s);var u=this.isInstanced?(i?this.ATTRIBUTES_ITEMS_COUNT:ca(this.CONSTANT_ATTRIBUTES))*Float32Array.BYTES_PER_ELEMENT:this.ATTRIBUTES_ITEMS_COUNT*Float32Array.BYTES_PER_ELEMENT;l.vertexAttribPointer(s,t.size,t.type,t.normalized||!1,u,r),this.isInstanced&&i&&l.vertexAttribDivisor(s,1)}return t.size*o}},{key:"unbindAttribute",value:function(t,e,r){var i=e.attributeLocations[t.name],o=e.gl;i!==-1&&(o.disableVertexAttribArray(i),this.isInstanced&&r&&o.vertexAttribDivisor(i,0))}},{key:"reallocate",value:function(t){t!==this.capacity&&(this.capacity=t,this.verticesCount=this.VERTICES*t,this.floats=new Float32Array(this.isInstanced?this.capacity*this.ATTRIBUTES_ITEMS_COUNT:this.verticesCount*this.ATTRIBUTES_ITEMS_COUNT),this.ints=new Uint32Array(this.floats.buffer),this.invalidateBuffers())}},{key:"invalidateBuffers",value:function(){this.bufferGeneration++,this.constantBufferGeneration++}},{key:"hasNothingToRender",value:function(){return this.verticesCount===0}},{key:"setTypedUniform",value:function(t,e){var r;xa(e.gl,(r=e.uniformLocations[t.name])!==null&&r!==void 0?r:null,t)}},{key:"renderProgram",value:function(t,e){var r=e.gl,i=e.program,o=e.isPicking;o?r.disable(r.BLEND):r.enable(r.BLEND),r.useProgram(i),this.setUniforms(t,e),this.drawWebGL(this.METHOD,e)}},{key:"render",value:function(t,e,r){var i;if(!this.shadersLogged&&(i=this.renderer)!==null&&i!==void 0&&i.getSetting("DEBUG_logShaders")&&(this.shadersLogged=!0,console.log("[sigma] DEBUG_logShaders: ".concat(this.constructor.name),{normal:{vertexShaderSource:this.VERTEX_SHADER_SOURCE,fragmentShaderSource:this.FRAGMENT_SHADER_SOURCE},pick:{vertexShaderSource:En(this.VERTEX_SHADER_SOURCE),fragmentShaderSource:En(this.FRAGMENT_SHADER_SOURCE)}})),!this.hasNothingToRender()){this.renderOffset=e??0,this.renderCount=r??-1;var o=this.normalProgram.gl;if(o.bindFramebuffer(o.FRAMEBUFFER,null),o.viewport(0,0,t.width*t.pixelRatio,t.height*t.pixelRatio),this.bindProgram(this.normalProgram),this.renderProgram(t,this.normalProgram),this.unbindProgram(this.normalProgram),this.pickProgram&&t.pickingFrameBuffer){var s=Math.ceil(t.width*t.pixelRatio/t.downSizingRatio),l=Math.ceil(t.height*t.pixelRatio/t.downSizingRatio);o.bindFramebuffer(o.FRAMEBUFFER,t.pickingFrameBuffer),o.viewport(0,0,s,l),this.bindProgram(this.pickProgram),this.renderProgram(t,this.pickProgram),this.unbindProgram(this.pickProgram),o.bindFramebuffer(o.FRAMEBUFFER,null),o.viewport(0,0,t.width*t.pixelRatio,t.height*t.pixelRatio)}}}},{key:"drawWebGL",value:function(t,e){var r,i=e.gl,o=this.renderCount>=0?this.renderCount:this.capacity;(r=this.renderer)!==null&&r!==void 0&&r.getSetting("DEBUG_logRenderStats")&&(this.debugStats.drawCalls++,this.debugStats.verticesDrawn+=o*this.VERTICES),this.isInstanced?i.drawArraysInstanced(t,0,this.VERTICES,o):i.drawArrays(t,this.renderOffset*this.VERTICES,o*this.VERTICES)}}])}(),Oe=2,Ot=7,hi={below:0,above:1,left:2,right:3};function ou(){var n=`#version 300 es
precision highp float;

uniform mat3 u_matrix;
uniform vec2 u_resolution;
uniform float u_labelPixelSnapping;
uniform float u_sizeRatio;
uniform float u_correctionRatio;
uniform float u_cameraAngle;
uniform float u_pixelRatio;
uniform float u_labelMargin;
uniform float u_zoomLabelSizeRatio;

uniform sampler2D u_nodeDataTexture;
uniform int u_nodeDataTextureWidth;
uniform sampler2D u_nodeFrameTexture;
uniform int u_nodeFrameTextureWidth;

// Atlas size is fixed at 2048\xD72048 \u2014 matches AttachmentManager.ATLAS_SIZE.
uniform sampler2D u_atlasTexture;
const vec2 u_atlasSize = vec2(2048.0);

// Per-instance
in float a_nodeIndex;           // node-data texture index
in vec4 a_atlasRect;            // x, y, width, height in atlas pixels
in vec2 a_attachmentSize;       // attachment dimensions (CSS px)
in float a_positionMode;        // label position: 0=right 1=left 2=above 3=below 4=over
in float a_attachmentPlacement; // 0=below 1=above 2=left 3=right (relative to label)
in float a_labelWidth;          // label width (CSS px)
in float a_labelHeight;         // label height: font line box (CSS px)
in float a_textHeight;          // actual glyph height (CSS px)
in float a_labelAngle;          // label rotation angle (radians)

// Per-vertex (constant)
in vec2 a_quadCorner;           // [-1,-1], [1,-1], [-1,1], [1,1]

out vec2 v_texCoord;

`.concat(Ne,`
`).concat(Ke,`
`).concat(yt,`
`).concat(ui,`
`).concat(ql,`

void main() {
  int nodeIdx = int(a_nodeIndex);

  // Node data: (x, y, size, shapeId).
  vec4 nodeData = readNodeData(u_nodeDataTexture, u_nodeDataTextureWidth, nodeIdx);
  vec2 nodePos = nodeData.xy;
  float nodeSize = nodeData.z;

  // Normalized edge distance from the shared frame texture (the frame-pass ran
  // the SDF search once; we just read the result).
  float edgeDist = readFrameTexel(u_nodeFrameTexture, u_nodeFrameTextureWidth, nodeIdx).r;

  // Per-node label rotation alignment: 0 = viewport, 1 = label turns with camera.
  float labelRotation = readNodeFlags(u_nodeDataTexture, u_nodeDataTextureWidth, nodeIdx).g;

  vec3 nodeClip = u_matrix * vec3(nodePos, 1.0);

  // Node radius in physical pixels (matches label/background).
  float matrixScaleX = length(vec2(u_matrix[0][0], u_matrix[1][0]));
  float nodeRadiusGraphSpace = nodeSize * u_correctionRatio / u_sizeRatio * 2.0;
  float nodeRadiusPixels = nodeRadiusGraphSpace * matrixScaleX * u_resolution.x / 2.0;

  // CSS-px inputs -> physical px, scaled by the zoom-dependent label ratio, so
  // the attachment stays glued to the label box exactly as the label scales.
  float zoomScale = u_zoomLabelSizeRatio;
  vec2 labelHalf = vec2(a_labelWidth, a_labelHeight) * 0.5 * zoomScale * u_pixelRatio;
  vec2 attachHalf = a_attachmentSize * 0.5 * zoomScale * u_pixelRatio;
  float gap = `).concat(Oe.toFixed(1),` * zoomScale * u_pixelRatio;
  float labelMargin = u_labelMargin * zoomScale * u_pixelRatio;

  // Graph-aligned labels add the camera angle so the attachment orbits with the box.
  mat2 labelRotMat = rotate2D(a_labelAngle - labelRotation * u_cameraAngle);

  // Label box center relative to the node center (pre-rotation). The shape-aware
  // edge distance comes from the frame texture, so placement matches the label.
  vec2 boxCenter = vec2(0.0);
  if (a_positionMode < 4.0) {
    float labelStart = nodeRadiusPixels * edgeDist + labelMargin;
    float textHalf = a_textHeight * 0.5 * zoomScale * u_pixelRatio;
    boxCenter = labelBoxCenter(a_positionMode, labelStart, labelHalf, textHalf);
  }

  // Horizontal anchor of below/above attachments tracks the label position, so
  // the attachment hangs from the label edge nearest the node (or is centered
  // when the label itself is node-centered): right->left, left->right, else center.
  float anchorX = 0.0;
  if (a_positionMode < 0.5) anchorX = -labelHalf.x + attachHalf.x;       // right label
  else if (a_positionMode < 1.5) anchorX = labelHalf.x - attachHalf.x;   // left label

  // Attachment center relative to the box (pre-rotation, Y-down). This offset
  // depends only on the box, the gap and the attachment size \u2014 never the shape.
  vec2 attachCenter;
  if (a_attachmentPlacement < 0.5) {
    // below
    attachCenter = boxCenter + vec2(anchorX, labelHalf.y + gap + attachHalf.y);
  } else if (a_attachmentPlacement < 1.5) {
    // above
    attachCenter = boxCenter + vec2(anchorX, -(labelHalf.y + gap + attachHalf.y));
  } else if (a_attachmentPlacement < 2.5) {
    // left, top-aligned
    attachCenter = boxCenter + vec2(-(labelHalf.x + gap + attachHalf.x), -labelHalf.y + attachHalf.y);
  } else {
    // right, top-aligned
    attachCenter = boxCenter + vec2(labelHalf.x + gap + attachHalf.x, -labelHalf.y + attachHalf.y);
  }

  // Rotate the whole assembly by the label angle, around the node center.
  vec2 rotatedCenter = labelRotMat * attachCenter;
  vec2 cornerOffset = labelRotMat * (a_quadCorner * attachHalf);

  // Node center in screen px (Y-down).
  vec2 nodeScreen = vec2(
    (nodeClip.x + 1.0) * u_resolution.x,
    (1.0 - nodeClip.y) * u_resolution.y
  ) * 0.5;

  // Snap node center to the pixel grid so label/backdrop/attachment move as one.
  vec2 snapDelta = (round(nodeScreen) - nodeScreen) * u_labelPixelSnapping;

  // Snap the quad's top-left to integer pixels so atlas texels map 1:1.
  vec2 centerScreen = nodeScreen + rotatedCenter + snapDelta;
  vec2 topLeft = centerScreen - attachHalf;
  topLeft = mix(topLeft, round(topLeft), u_labelPixelSnapping);
  centerScreen = topLeft + attachHalf;

  vec2 vertexScreen = centerScreen + cornerOffset;
  gl_Position = vec4(
    vertexScreen.x * 2.0 / u_resolution.x - 1.0,
    1.0 - vertexScreen.y * 2.0 / u_resolution.y,
    0.0, 1.0
  );

  vec2 texOrigin = a_atlasRect.xy / u_atlasSize;
  vec2 texSize = a_atlasRect.zw / u_atlasSize;
  vec2 uv = (a_quadCorner + 1.0) / 2.0;
  v_texCoord = texOrigin + uv * texSize;
}
`);return n}var su=`#version 300 es
precision highp float;

uniform sampler2D u_atlasTexture;

in vec2 v_texCoord;

layout(location = 0) out vec4 fragColor;
#ifdef PICKING_MODE
layout(location = 1) out vec4 pickColor;
#endif

void main() {
  // Canvas textures are premultiplied; output directly for (ONE, 1-SRC_ALPHA) blending
  vec4 color = texture(u_atlasTexture, v_texCoord);
  if (color.a < 0.01) discard;
  fragColor = color;
#ifdef PICKING_MODE
  pickColor = vec4(0.0); // Attachments are not pickable
#endif
}
`;function lu(n,a,t,e){var r,i,o=e.label,s=o===void 0?{}:o,l=(r=s.margin)!==null&&r!==void 0?r:mt,u=(i=s.zoomToLabelSizeRatioFunction)!==null&&i!==void 0?i:function(){return 1},d=ou(),h=su,c=function(f){function g(){var m;Y(this,g);for(var p=arguments.length,v=new Array(p),y=0;y<p;y++)v[y]=arguments[y];return m=te(this,g,[].concat(v)),E(m,"totalCount",0),E(m,"bufferCapacity",0),m}return ne(g,f),K(g,[{key:"getDefinition",value:function(){var p=WebGL2RenderingContext,v=p.FLOAT,y=p.TRIANGLE_STRIP;return{VERTICES:4,VERTEX_SHADER_SOURCE:d,FRAGMENT_SHADER_SOURCE:h,METHOD:y,UNIFORMS:["u_matrix","u_resolution","u_labelPixelSnapping","u_sizeRatio","u_correctionRatio","u_cameraAngle","u_pixelRatio","u_labelMargin","u_zoomLabelSizeRatio","u_nodeDataTexture","u_nodeDataTextureWidth","u_nodeFrameTexture","u_nodeFrameTextureWidth","u_atlasTexture"],ATTRIBUTES:[{name:"a_nodeIndex",size:1,type:v},{name:"a_atlasRect",size:4,type:v},{name:"a_attachmentSize",size:2,type:v},{name:"a_positionMode",size:1,type:v},{name:"a_attachmentPlacement",size:1,type:v},{name:"a_labelWidth",size:1,type:v},{name:"a_labelHeight",size:1,type:v},{name:"a_textHeight",size:1,type:v},{name:"a_labelAngle",size:1,type:v}],CONSTANT_ATTRIBUTES:[{name:"a_quadCorner",size:2,type:v}],CONSTANT_DATA:[[-1,-1],[1,-1],[-1,1],[1,1]]}}},{key:"processAttachment",value:function(p,v){var y=this.floats,b=p*this.STRIDE;y[b++]=v.nodeIndex,y[b++]=v.atlasX,y[b++]=v.atlasY,y[b++]=v.atlasW,y[b++]=v.atlasH,y[b++]=v.attachWidth,y[b++]=v.attachHeight,y[b++]=v.positionMode,y[b++]=v.attachmentPlacement,y[b++]=v.labelWidth,y[b++]=v.labelHeight,y[b++]=v.textHeight,y[b++]=v.labelAngle}},{key:"setUniforms",value:function(p,v){var y=v.gl,b=v.uniformLocations;y.uniformMatrix3fv(b.u_matrix,!1,p.matrix),y.uniform2f(b.u_resolution,p.width*p.pixelRatio,p.height*p.pixelRatio),y.uniform1f(b.u_labelPixelSnapping,p.labelPixelSnapping),y.uniform1f(b.u_sizeRatio,p.sizeRatio),y.uniform1f(b.u_correctionRatio,p.correctionRatio),y.uniform1f(b.u_cameraAngle,p.cameraAngle),y.uniform1f(b.u_pixelRatio,p.pixelRatio),y.uniform1f(b.u_labelMargin,g.labelMargin),y.uniform1f(b.u_zoomLabelSizeRatio,1/u(p.zoomRatio)),y.uniform1i(b.u_nodeDataTexture,p.nodeDataTextureUnit),y.uniform1i(b.u_nodeDataTextureWidth,p.nodeDataTextureWidth),y.uniform1i(b.u_nodeFrameTexture,p.nodeFrameTextureUnit),y.uniform1i(b.u_nodeFrameTextureWidth,p.nodeFrameTextureWidth),y.uniform1i(b.u_atlasTexture,Ot)}},{key:"reallocateAttachments",value:function(p){this.totalCount=p,p>this.bufferCapacity&&(this.bufferCapacity=Math.max(p,Math.ceil(this.bufferCapacity*1.5)||10),se(g,"reallocate",this,3)([this.bufferCapacity]))}},{key:"hasNothingToRender",value:function(){return this.totalCount===0}},{key:"drawWebGL",value:function(p,v){var y=v.gl;this.totalCount!==0&&y.drawArraysInstanced(p,0,this.VERTICES,this.totalCount)}}])}(Ze);return E(c,"labelMargin",l),new c(n,a,t)}var Be=5;function Fn(n,a){return[].concat($(a),$(n.map(function(t){var e;return{attributes:(e=t.attributes)!==null&&e!==void 0?e:[]}})))}function bt(n,a){var t=Te(Fn(n,a)),e=new Set(n.flatMap(function(u){var d;return(d=u.attributes)!==null&&d!==void 0?d:[]}).map(function(u){return u.name.replace(/^a_/,"")})),r={},i={},o=z(e),s;try{for(o.s();!(s=o.n()).done;){var l=s.value;r[l]=t.offsets[l],i[l]=t.specs[l]}}catch(u){o.e(u)}finally{o.f()}return W(W({},t),{},{offsets:r,specs:i})}function uu(n,a){var t=new Set(["u_matrix","u_sizeRatio","u_correctionRatio","u_cameraAngle","u_pickingPadding","u_nodeDataTexture","u_layerAttributeTexture"]),e=new Set,r=n.flatMap(function(f){return f.uniforms}).filter(function(f){return t.has(f.name)||e.has(f.name)?!1:(e.add(f.name),!0)}).map(function(f){return"uniform ".concat(f.type," ").concat(f.name,";")}).join(`
`),i=a.flatMap(function(f){return f.uniforms}).filter(function(f){return t.has(f.name)||e.has(f.name)?!1:(e.add(f.name),!0)}).map(function(f){return"uniform ".concat(f.type," ").concat(f.name,";")}).join(`
`),o=Fn(n,a),s=new Set,l=o.flatMap(function(f){return f.attributes}).filter(function(f){var g=f.name.replace(/^a_/,"");return s.has(g)?!1:(s.add(g),!0)}).map(function(f){var g=f.name.replace(/^a_/,""),m=f.size===1?"float":"vec".concat(f.size);return"out ".concat(m," v_").concat(g,";")}).join(`
`),u=vt(Te(o),{varPrefix:"layer",baseTexelExpr:"nodeIdx * u_layerAttributeTexelsPerNode",textureWidthUniform:"u_layerAttributeTextureWidth",textureSamplerUniform:"u_layerAttributeTexture"}),d=u.fetchCode,h=u.varyingAssignments,c=`#version 300 es

// Standard node attributes (per instance) - minimal buffer usage
in float a_nodeIndex;  // Index into node data texture AND layer attribute texture
in vec4 a_id;          // Node ID for picking
in float a_opacity;    // Node opacity, applied once to the final fragment

// Constant attributes (per vertex, same for all instances)
in vec2 a_quadCorner;  // (-1,-1), (1,-1), (1,1), (-1,1) for quad corners

// Standard uniforms
uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_correctionRatio;
uniform float u_cameraAngle;
#ifdef PICKING_MODE
uniform float u_pickingPadding;
#endif
uniform sampler2D u_nodeDataTexture;
uniform int u_nodeDataTextureWidth;

// Layer attribute texture uniforms
uniform sampler2D u_layerAttributeTexture;
uniform int u_layerAttributeTextureWidth;
uniform int u_layerAttributeTexelsPerNode;

`.concat(r,`
`).concat(i,`

// Standard varyings
out vec2 v_uv;                    // Normalized coordinates [-1, 1]
out vec4 v_id;
out float v_opacity;
out float v_antialiasingWidth;    // Width for antialiasing in UV space
out float v_pixelSize;            // Node size in pixels (for pixel-mode borders)
out float v_pixelToUV;            // Conversion factor: multiply by this to convert screen pixels to UV units
out float v_shapeId;              // Shape ID for multi-shape programs

// Layer varyings
`).concat(l,`

// Node-data fetch helpers (geometry texel + rotation-flags texel)
`).concat(Ne,`
`).concat(Ke,`

void main() {
  // Fetch node geometry: vec4(x, y, size, shapeId).
  int nodeIdx = int(a_nodeIndex);

  // Hidden nodes are flagged with a negative row by NodeProgram.process(). Push
  // the whole quad outside the clip volume: every vertex lands at the same
  // out-of-range position, so the primitive is fully clipped and rasterizes
  // nothing \u2014 neither to the frame buffer nor to the picking buffer.
  if (nodeIdx < 0) {
    gl_Position = vec4(2.0, 0.0, 0.0, 1.0);
    v_id = vec4(0.0);
    return;
  }

  vec4 nodeData = readNodeData(u_nodeDataTexture, u_nodeDataTextureWidth, nodeIdx);
  vec2 a_position = nodeData.xy;
  float a_size = nodeData.z;
  v_shapeId = nodeData.w;  // Pass shape ID to fragment shader

  // Per-node rotation alignment: 0 = viewport (screen-upright), 1 = graph.
  float nodeRotation = readNodeFlags(u_nodeDataTexture, u_nodeDataTextureWidth, nodeIdx).r;

`).concat(d,`

  // Calculate the actual size in pixels
  float size = a_size * u_correctionRatio / u_sizeRatio * 2.0;

  // In PICKING_MODE, inflate the quad by nodePickingPadding pixels on each side
  #ifdef PICKING_MODE
    float paddedSize = size + u_pickingPadding * u_correctionRatio;
    vec2 offset = a_quadCorner * paddedSize;
  #else
    vec2 offset = a_quadCorner * size;
  #endif
  // Counter-rotate the quad offset so viewport-aligned nodes stay upright as the
  // camera turns. Graph-aligned nodes (nodeRotation=1) skip it and turn with the
  // camera. The angle scales by (1 - nodeRotation) so both fall out of one path.
  {
    float ca = u_cameraAngle * (1.0 - nodeRotation);
    float c = cos(ca);
    float s = sin(ca);
    offset = mat2(c, s, -s, c) * offset;
  }
  vec2 position = a_position + offset;

  gl_Position = vec4(
    (u_matrix * vec3(position, 1)).xy,
    0,
    1
  );

  // In PICKING_MODE, UV is scaled beyond [-1, 1] to match the inflated quad
  #ifdef PICKING_MODE
    v_uv = a_quadCorner * (paddedSize / size);
  #else
    v_uv = a_quadCorner;
  #endif

  // Pass ID to fragment shader
  v_id = a_id;
  v_opacity = a_opacity;

  // Pass pixel size for layers that need pixel-mode calculations
  // Multiply by 2 because 'size' is half-width (offset from center), not full diameter
  v_pixelSize = size * 2.0;

  // Conversion factor from screen pixels to UV units
  // Same derivation as v_antialiasingWidth which represents ~1 pixel in UV space
  // P pixels in UV space = P * u_correctionRatio / size
  v_pixelToUV = u_correctionRatio / size;

  // We use an antialiasing width of 1px (so v_pixelToUV)
  v_antialiasingWidth = v_pixelToUV;

  // Pass layer attributes to fragment shader (fetched from texture)
`).concat(h,`
}
`);return c}function du(n,a,t){var e=arguments.length>3&&arguments[3]!==void 0?arguments[3]:!0,r=a.map(function(g,m){var p="layer_".concat(g.name),v=[].concat($(g.attributes.map(function(y){return"v_".concat(y.name.replace(/^a_/,""))})),$(g.uniforms.map(function(y){return y.name}))).join(", ");return"  // Layer ".concat(m+1,": ").concat(g.name,`
  color = blendOver(color, `).concat(p,"(").concat(v,"));")}).join(`

`),i=new Set(["u_correctionRatio"]),o=new Set,s=n.flatMap(function(g){return g.uniforms}).filter(function(g){return i.has(g.name)||o.has(g.name)?!1:(o.add(g.name),!0)}).map(function(g){return"uniform ".concat(g.type," ").concat(g.name,";")}).join(`
`),l=a.flatMap(function(g){return g.uniforms}).filter(function(g){return i.has(g.name)||o.has(g.name)?!1:(o.add(g.name),!0)}).map(function(g){return"uniform ".concat(g.type," ").concat(g.name,";")}).join(`
`),u=new Set,d=Fn(n,a).flatMap(function(g){return g.attributes}).filter(function(g){var m=g.name.replace(/^a_/,"");return u.has(m)?!1:(u.add(m),!0)}).map(function(g){var m=g.name.replace(/^a_/,""),p=g.size===1?"float":"vec".concat(g.size);return"in ".concat(p," v_").concat(m,";")}).join(`
`),h=ma(n),c=Xl(n,t),f=`#version 300 es
precision highp float;

// Standard varyings
in vec2 v_uv;
in vec4 v_id;
in float v_opacity;
in float v_antialiasingWidth;
in float v_pixelSize;
in float v_pixelToUV;
in float v_shapeId;  // Shape ID for multi-shape programs

// Standard uniforms (needed for some layer calculations like pixel-mode borders)
uniform float u_correctionRatio;
#ifdef PICKING_MODE
uniform float u_pickingPadding;
#endif

// Shape uniforms
`.concat(s,`

// Layer uniforms
`).concat(l,`

// Layer varyings
`).concat(d,`

// Fragment output (single target - picking handled via separate pass)
out vec4 fragColor;

// LayerContext struct - provides rendering context to all layers
struct LayerContext {
  float sdf;             // Signed distance from shape boundary (negative inside)
  vec2 uv;               // UV coordinates [-1, 1], center at (0,0)
  float shapeSize;       // Effective shape size (~diameter) in UV space (1.0 - aaWidth)
  float shapeHalfSize;   // Effective shape half size (~radius) in UV space
  float pixelSize;       // Node full size (~diameter) in screen pixels
  float aaWidth;         // Anti-aliasing width for smooth transitions
  float correctionRatio; // Scaling factor for consistent rendering across zoom levels
  float pixelToUV;       // Conversion factor: multiply screen pixels by this to get UV units
  float inradiusFactor;  // Ratio of inradius to circumradius (shape depth factor)
};

LayerContext context;  // Global instance, populated before layer calls

// Alpha "over" compositing for layer blending
vec4 blendOver(vec4 bg, vec4 fg) {
  float a = fg.a;
  return vec4(mix(bg.rgb, fg.rgb, a), bg.a + a * (1.0 - bg.a));
}

// SDF shape functions
`).concat(h,`

// Shape selector function (sets context.sdf and context.inradiusFactor)
`).concat(c,`

// Layer functions
`).concat(a.map(function(g){return g.glsl}).join(`

`),`

void main() {
  // 1. Setup LayerContext (available to all layer functions)
  context.shapeSize = 1.0 - v_antialiasingWidth;
  context.shapeHalfSize = context.shapeSize * 0.5;
  context.pixelSize = v_pixelSize;
  context.uv = v_uv;
  context.aaWidth = v_antialiasingWidth;
  context.correctionRatio = u_correctionRatio;
  context.pixelToUV = v_pixelToUV;

  // Query shape SDF based on shapeId (sets context.sdf and context.inradiusFactor)
  queryNodeSDF(int(v_shapeId), v_uv, context.shapeSize);

  // 2. Early discard for pixels fully outside the shape (with AA margin)
  // In PICKING_MODE, allow extra fragments up to the picking padding distance
  #ifdef PICKING_MODE
    if (context.sdf > u_pickingPadding * v_pixelToUV + context.aaWidth) discard;
  #else
    if (context.sdf > context.aaWidth) discard;
  #endif

  // 3. Apply layers sequentially with "over" compositing
  vec4 color = vec4(0.0);

`).concat(r,`

  #ifdef PICKING_MODE
    // Picking pass: output node ID for pixels within the picking area.
    if (context.sdf > u_pickingPadding * v_pixelToUV) discard;
    fragColor = v_id;
  #else
`).concat(e?`    // Visual pass: apply antialiasing at shape boundary, node opacity once
    // smoothstep provides smooth transition from opaque to transparent
    float alpha = smoothstep(context.aaWidth, -context.aaWidth, context.sdf) * v_opacity;`:`    // Visual pass: hard-edged (no anti-aliasing gradient) shape boundary, node opacity applied once
    float alpha = (context.sdf < 0.0 ? 1.0 : 0.0) * v_opacity;`,`
    // Mix with transparent to fade both color AND alpha together (avoids bright halo)
    fragColor = mix(vec4(0.0), color, alpha);
  #endif
}
`);return f}function hu(n,a){var t=new Set;return t.add("u_matrix"),t.add("u_sizeRatio"),t.add("u_correctionRatio"),t.add("u_cameraAngle"),t.add("u_pickingPadding"),t.add("u_nodeDataTexture"),t.add("u_nodeDataTextureWidth"),t.add("u_layerAttributeTexture"),t.add("u_layerAttributeTextureWidth"),t.add("u_layerAttributeTexelsPerNode"),n.forEach(function(e){e.uniforms.forEach(function(r){return t.add(r.name)})}),a.forEach(function(e){e.uniforms.forEach(function(r){return t.add(r.name)})}),Array.from(t)}function cu(n){var a=WebGL2RenderingContext,t=a.UNSIGNED_BYTE,e=a.FLOAT;return[{name:"a_nodeIndex",size:1,type:e},{name:"a_id",size:4,type:t,normalized:!0},{name:"a_opacity",size:1,type:e}]}function Yr(n){var a=n.shapes,t=n.layers,e=n.shapeGlobalIds,r=n.antialias,i=r===void 0?!0:r;return{vertexShader:uu(a,t),fragmentShader:du(a,t,e,i),uniforms:hu(a,t),attributes:cu()}}function ci(n,a,t){var e=bt(n,a),r=e.specs;return Object.keys(r).map(function(i){return"flat ".concat(t," ").concat(r[i].size===1?"float":"vec".concat(r[i].size)," v_").concat(i,";")}).join(`
`)}function fu(n){var a,t,e=n.shapes,r=n.layers,i=n.shapeGlobalIds,o=vt(bt(e,r),{varPrefix:"nodeAttr",baseTexelExpr:"nodeIdx * u_layerAttributeTexelsPerNode",textureWidthUniform:"u_layerAttributeTextureWidth",textureSamplerUniform:"u_layerAttributeTexture"}),s=e.length===1?"float inradiusFactor = ".concat(re((a=e[0].inradiusFactor)!==null&&a!==void 0?a:1),";"):"float inradiusFactor = ".concat(re((t=e[0].inradiusFactor)!==null&&t!==void 0?t:1),`;
  switch (int(shapeId)) {
`).concat(e.map(function(u,d){var h,c=i?i[d]:d;return"    case ".concat(c,": inradiusFactor = ").concat(re((h=u.inradiusFactor)!==null&&h!==void 0?h:1),"; break;")}).join(`
`),`
    default: break;
  }`),l=`#version 300 es

in float a_nodeIndex;
in float a_labelWidth;
in float a_labelHeight;
in float a_textHeight;
in float a_positionMode;
in float a_labelAngle;
in vec4 a_backdropColor;
in vec4 a_backdropShadowColor;
in float a_backdropShadowBlur;
in float a_backdropPadding;
in vec4 a_backdropBorderColor;
in vec4 a_backdropExtra; // [borderWidth, cornerRadius, labelPadding, area]
in vec2 a_labelBoxOffset;
in vec2 a_quadCorner;

uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_correctionRatio;
uniform float u_cameraAngle;
uniform vec2 u_resolution;
uniform float u_pixelRatio;
uniform float u_labelMargin;
uniform float u_zoomLabelSizeRatio;
uniform float u_labelPixelSnapping;
uniform sampler2D u_nodeDataTexture;
uniform int u_nodeDataTextureWidth;
uniform sampler2D u_nodeFrameTexture;
uniform int u_nodeFrameTextureWidth;
uniform sampler2D u_layerAttributeTexture;
uniform int u_layerAttributeTextureWidth;
uniform int u_layerAttributeTexelsPerNode;

out vec2 v_uv;
out vec2 v_nodeCenter;
out float v_nodeRadius;
out vec2 v_labelCenter;
out vec2 v_labelHalfSize;
out float v_aaWidth;
out float v_shapeId;
out float v_nodeRotation;
out float v_labelAngle;
out vec4 v_backdropColor;
out vec4 v_backdropShadowColor;
out float v_backdropShadowBlur;
out float v_backdropPadding;
out vec4 v_backdropBorderColor;
out float v_backdropBorderWidth;
out float v_backdropCornerRadius;
out float v_backdropArea;
`.concat(ci(e,r,"out"),`

`).concat(Ne,`
`).concat(Ke,`
`).concat(yt,`

void main() {
  int nodeIdx = int(a_nodeIndex);
`).concat(o.fetchCode,`
`).concat(o.varyingAssignments,`

  // Node data: (x, y, size, shapeId). shapeId (global) is forwarded to the
  // fragment shader, which keeps the shape SDF for the outline.
  vec4 nodeData = readNodeData(u_nodeDataTexture, u_nodeDataTextureWidth, nodeIdx);
  vec2 nodePosition = nodeData.xy;
  float nodeSize = nodeData.z;
  float shapeId = nodeData.w;

  // Per-node rotation alignment (0 = viewport, 1 = graph). nodeRotation drives
  // the fragment's shape outline; labelRotation turns the label box with camera.
  vec4 nodeFlags = readNodeFlags(u_nodeDataTexture, u_nodeDataTextureWidth, nodeIdx);
  float nodeRotation = nodeFlags.r;
  float labelRotation = nodeFlags.g;
  v_nodeRotation = nodeRotation;

  `).concat(si,`
  // CSS pixel attributes are multiplied by u_pixelRatio to match nodeRadiusPixels,
  // which is already in physical pixels (nodeRadiusNDC * u_resolution.x / 2.0).
  float padding = a_backdropPadding * u_pixelRatio;
  float shadowBlur = a_backdropShadowBlur * u_pixelRatio;
  // Unpack a_backdropExtra: [borderWidth, cornerRadius, labelPadding, area]
  float borderWidth = a_backdropExtra.x * u_pixelRatio;
  float cornerRadius = a_backdropExtra.y * u_pixelRatio;
  float labelPad = a_backdropExtra.z * u_pixelRatio;
  float backdropArea = a_backdropExtra.w;
  // Use 2x shadowBlur so the Gaussian fully decays before the quad edge
  float totalExpansion = shadowBlur * 2.0 + borderWidth;
  float enlargedRadius = nodeRadiusPixels + padding;

  // Circumscribed radius for the quad bounds. Non-circular shapes reach past
  // their inradius out to their circumradius (= enlargedRadius / inradiusFactor),
  // in any direction once rotated. The axis-aligned quad must contain that, or
  // the fill/shadow gets clipped (square corners, triangle tip, etc.).
  `).concat(s,`
  float boundRadius = enlargedRadius / inradiusFactor;

  // Apply zoom-dependent label size scaling
  float zoomScale = u_zoomLabelSizeRatio;
  float labelW = a_labelWidth * zoomScale * u_pixelRatio;
  float labelH = a_labelHeight * zoomScale * u_pixelRatio;
  float labelMargin = u_labelMargin * zoomScale * u_pixelRatio;

  // Only apply labelPad when a label is actually present
  float effectiveLabelPad = labelW > 0.0 ? labelPad : 0.0;
  vec2 labelHalfSize = vec2(labelW * 0.5 + effectiveLabelPad, labelH * 0.5 + effectiveLabelPad);
  vec2 labelOffset = vec2(0.0);

  // Effective label angle: intrinsic angle plus the camera angle when the label
  // is graph-aligned, so the box orbits the node in lockstep with the frame-pass.
  float labelAngle = a_labelAngle - labelRotation * u_cameraAngle;
  float la_c = cos(labelAngle);
  float la_s = sin(labelAngle);
  mat2 labelRotMat = mat2(la_c, -la_s, la_s, la_c);

  vec3 nodeClip = u_matrix * vec3(nodePosition, 1.0);
  vec2 snapDelta = vec2(0.0);

  if (labelW > 0.0) {
    // labelW > 0.0 means this node's label is displayed, so the frame-pass wrote
    // its edge distance this frame.
    float edgeDistPixels = nodeRadiusPixels * readFrameTexel(u_nodeFrameTexture, u_nodeFrameTextureWidth, nodeIdx).r;
    // labelMargin matches the label shader's margin (gap from node edge to text)
    float labelStart = edgeDistPixels + labelMargin;
    // Above/below center on the actual glyph height, not the font line box, so
    // the box stays aligned with the rendered text (matches labelBoxCenter()).
    float textHalf = a_textHeight * zoomScale * u_pixelRatio * 0.5;

    // Snap node center to pixel grid so label/backdrop/attachment move as a unit
    vec2 nodeScreen = vec2(
      (nodeClip.x + 1.0) * u_resolution.x,
      (1.0 - nodeClip.y) * u_resolution.y
    ) * 0.5;
    snapDelta = (round(nodeScreen) - nodeScreen) * u_labelPixelSnapping;

    if (a_positionMode < 0.5) {
      // Right: box spans from node center to text end + padding
      float boxRightEdge = labelStart + labelW + labelPad;
      labelOffset = vec2(boxRightEdge * 0.5, 0.0);
      labelHalfSize.x = boxRightEdge * 0.5;
    } else if (a_positionMode < 1.5) {
      // Left: mirror of right
      float boxLeftEdge = labelStart + labelW + labelPad;
      labelOffset = vec2(-boxLeftEdge * 0.5, 0.0);
      labelHalfSize.x = boxLeftEdge * 0.5;
    } else if (a_positionMode < 2.5) {
      // Above: text bottom at labelStart, centered horizontally
      labelOffset = vec2(0.0, -(labelStart + textHalf));
    } else if (a_positionMode < 3.5) {
      // Below: text top at labelStart, centered horizontally
      labelOffset = vec2(0.0, labelStart + textHalf);
    }
    // over (>=4): labelOffset stays (0,0) \u2014 text centered on the node.

    // The attachment-cover shift is in label space (like the attachment itself),
    // so rotate it together with the position offset \u2014 otherwise the box drifts
    // off the attachment as the label angle grows.
    labelOffset = labelRotMat * (labelOffset + a_labelBoxOffset * zoomScale * u_pixelRatio);
  }

  // For node-only mode, zero out label dimensions
  if (backdropArea > 0.5 && backdropArea < 1.5) {
    labelHalfSize = vec2(0.0);
    labelOffset = vec2(0.0);
  }

  vec2 minBound, maxBound;

  bool hasLabelBounds = labelW > 0.0 && (backdropArea > 1.5 || backdropArea < 0.5);

  if (hasLabelBounds) {
    // Union with label bounds (area=both) or label-only bounds (area=label)
    vec2 labelMin, labelMax;

    if (a_labelAngle != 0.0) {
      vec2 corner1 = labelOffset + labelRotMat * vec2(-labelHalfSize.x, -labelHalfSize.y);
      vec2 corner2 = labelOffset + labelRotMat * vec2(labelHalfSize.x, -labelHalfSize.y);
      vec2 corner3 = labelOffset + labelRotMat * vec2(labelHalfSize.x, labelHalfSize.y);
      vec2 corner4 = labelOffset + labelRotMat * vec2(-labelHalfSize.x, labelHalfSize.y);
      labelMin = min(min(corner1, corner2), min(corner3, corner4));
      labelMax = max(max(corner1, corner2), max(corner3, corner4));
    } else {
      labelMin = labelOffset - labelHalfSize;
      labelMax = labelOffset + labelHalfSize;
    }

    if (backdropArea > 1.5) {
      // Label-only: bounds from label rect only
      minBound = labelMin - totalExpansion;
      maxBound = labelMax + totalExpansion;
    } else {
      // Both: union of node + label
      minBound = min(-vec2(boundRadius), labelMin) - totalExpansion;
      maxBound = max(vec2(boundRadius), labelMax) + totalExpansion;
    }
  } else {
    // Node-only or no visible label
    float totalRadius = boundRadius + totalExpansion;
    minBound = -vec2(totalRadius);
    maxBound = vec2(totalRadius);
  }

  vec2 quadSize = maxBound - minBound;
  vec2 quadCenter = (minBound + maxBound) * 0.5;

  vec2 localPos = quadCenter + a_quadCorner * quadSize * 0.5 + snapDelta;
  vec2 ndcOffset = localPos * 2.0 / u_resolution;
  ndcOffset.y = -ndcOffset.y;

  gl_Position = vec4(nodeClip.xy + ndcOffset, 0.0, 1.0);

  v_uv = localPos;
  v_nodeCenter = vec2(0.0);
  v_nodeRadius = nodeRadiusPixels;
  v_labelCenter = labelOffset;
  v_labelHalfSize = labelHalfSize;
  v_aaWidth = 1.0;
  v_shapeId = shapeId;
  v_labelAngle = labelAngle;
  v_backdropColor = a_backdropColor;
  v_backdropShadowColor = a_backdropShadowColor;
  v_backdropShadowBlur = a_backdropShadowBlur;
  v_backdropPadding = a_backdropPadding;
  v_backdropBorderColor = a_backdropBorderColor;
  v_backdropBorderWidth = borderWidth;
  v_backdropCornerRadius = cornerRadius;
  v_backdropArea = backdropArea;
}
`);return l}function gu(n){var a=n.shapes,t=n.layers,e=n.shapeGlobalIds,r=ma(a),i=Ut(a).map(function(c){return"uniform ".concat(c.type," ").concat(c.name,";")}).join(`
`),o=function(f){return Rn(f,"nodeUV","1.0")},s;if(a.length===1)s="float nodeSdfNormalized = ".concat(o(a[0]),";");else{var l=a.map(function(c,f){var g=e?e[f]:f;return"    case ".concat(g,": nodeSdfNormalized = ").concat(o(c),"; break;")}).join(`
`),u=o(a[0]);s=`float nodeSdfNormalized;
  int shapeId = int(v_shapeId);
  switch (shapeId) {
`.concat(l,`
    default: nodeSdfNormalized = `).concat(u,`;
  }`)}var d=`float effectiveRadius = max(enlargedRadius - cornerRadius, 0.01);
  float ca = u_cameraAngle * v_nodeRotation;
  float ca_c = cos(ca);
  float ca_s = sin(ca);
  vec2 rotatedScreenUV = mat2(ca_c, -ca_s, ca_s, ca_c) * screenUV;
  vec2 nodeUV = vec2(rotatedScreenUV.x, -rotatedScreenUV.y) / effectiveRadius;`,h=`#version 300 es
precision highp float;

in vec2 v_uv;
in vec2 v_nodeCenter;
in float v_nodeRadius;
in vec2 v_labelCenter;
in vec2 v_labelHalfSize;
in float v_aaWidth;
in float v_shapeId;
in float v_nodeRotation;
in float v_labelAngle;
in vec4 v_backdropColor;
in vec4 v_backdropShadowColor;
in float v_backdropShadowBlur;
in float v_backdropPadding;
in vec4 v_backdropBorderColor;
in float v_backdropBorderWidth;
in float v_backdropCornerRadius;
in float v_backdropArea;
`.concat(ci(a,t,"in"),`

uniform float u_cameraAngle;
`).concat(i,`

layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragPicking;

`).concat(r,`
`).concat(Yl,`
`).concat(Kl,`
`).concat(Zl,`
`).concat(Ql,`

void main() {
  vec4 backdropColor = v_backdropColor;
  vec4 shadowColor = v_backdropShadowColor;
  float shadowBlur = v_backdropShadowBlur;
  float padding = v_backdropPadding;
  vec4 borderColor = v_backdropBorderColor;
  float borderWidth = v_backdropBorderWidth;
  float cornerRadius = v_backdropCornerRadius;

  float enlargedRadius = v_nodeRadius + padding;
  vec2 screenUV = v_uv - v_nodeCenter;
  `).concat(d,`

  // Query the correct shape SDF based on shapeId
  `).concat(s,`
  float nodeSdfPixels = nodeSdfNormalized * effectiveRadius - cornerRadius;

  // Label SDF with optional corner radius and rotation
  float labelSdfPixels;
  if (v_labelHalfSize.x > 0.0) {
    vec2 labelP = v_uv - v_labelCenter;
    labelSdfPixels = sdfRoundedRotatedBox(labelP, v_labelHalfSize, v_labelAngle, cornerRadius);
  } else {
    labelSdfPixels = 10000.0;
  }

  // Select area: 0=both, 1=node, 2=label
  float combinedSdf;
  if (v_backdropArea > 1.5) {
    combinedSdf = labelSdfPixels;
  } else if (v_backdropArea > 0.5) {
    combinedSdf = nodeSdfPixels;
  } else {
    combinedSdf = min(nodeSdfPixels, labelSdfPixels);
  }

  // Fill + border composite
  float outerEdge = smoothstep(v_aaWidth, -v_aaWidth, combinedSdf);
  vec4 background;
  if (borderWidth > 0.5) {
    float innerEdge = smoothstep(v_aaWidth, -v_aaWidth, combinedSdf + borderWidth);
    float fillAlpha = innerEdge * backdropColor.a;
    vec4 fill = vec4(backdropColor.rgb * fillAlpha, fillAlpha);
    float borderAlpha = (outerEdge - innerEdge) * borderColor.a;
    vec4 border = vec4(borderColor.rgb * borderAlpha, borderAlpha);
    background = fill + border * (1.0 - fill.a);
  } else {
    float fillAlpha = outerEdge * backdropColor.a;
    background = vec4(backdropColor.rgb * fillAlpha, fillAlpha);
  }

  // Gaussian-like shadow falloff (mimics canvas shadowBlur)
  vec4 shadow = vec4(0.0);
  float sigma = shadowBlur / 2.5;
  if (sigma > 0.001) {
    float shadowDist = max(0.0, combinedSdf);
    float shadowAlpha = exp(-(shadowDist * shadowDist) / (2.0 * sigma * sigma)) * shadowColor.a;
    shadow = vec4(shadowColor.rgb * shadowAlpha, shadowAlpha);
  }

  fragColor = background + shadow * (1.0 - background.a);
  fragPicking = vec4(0.0);
}
`);return h}function vu(n){var a=["u_matrix","u_sizeRatio","u_correctionRatio","u_cameraAngle","u_resolution","u_pixelRatio","u_labelMargin","u_zoomLabelSizeRatio","u_labelPixelSnapping","u_nodeDataTexture","u_nodeDataTextureWidth","u_nodeFrameTexture","u_nodeFrameTextureWidth","u_layerAttributeTexture","u_layerAttributeTextureWidth","u_layerAttributeTexelsPerNode"],t=z(Ut(n)),e;try{for(t.s();!(e=t.n()).done;){var r=e.value;a.includes(r.name)||a.push(r.name)}}catch(i){t.e(i)}finally{t.f()}return a}function pu(n){return{vertexShader:fu(n),fragmentShader:gu(n),uniforms:vu(n.shapes)}}function mu(n,a,t,e){var r,i,o=e.label,s=o===void 0?{}:o,l=e.shapes,u=e.layers,d=e.getAttributeTexture,h=e.shapeGlobalIds;if(l.length===0)throw new Error("createBackdropProgram: at least one shape must be provided in 'shapes'");var c=(r=s.margin)!==null&&r!==void 0?r:5,f=(i=s.zoomToLabelSizeRatioFunction)!==null&&i!==void 0?i:function(){return 1},g={shapes:l,layers:u,shapeGlobalIds:h},m=pu(g),p=function(v){function y(){var b;Y(this,y);for(var T=arguments.length,x=new Array(T),_=0;_<T;_++)x[_]=arguments[_];return b=te(this,y,[].concat(x)),E(b,"totalBackdropCount",0),E(b,"bufferCapacity",0),b}return ne(y,v),K(y,[{key:"getDefinition",value:function(){var T=WebGL2RenderingContext,x=T.FLOAT,_=T.TRIANGLE_STRIP;return{VERTICES:4,VERTEX_SHADER_SOURCE:m.vertexShader,FRAGMENT_SHADER_SOURCE:m.fragmentShader,METHOD:_,UNIFORMS:m.uniforms,ATTRIBUTES:[{name:"a_nodeIndex",size:1,type:x},{name:"a_labelWidth",size:1,type:x},{name:"a_labelHeight",size:1,type:x},{name:"a_textHeight",size:1,type:x},{name:"a_positionMode",size:1,type:x},{name:"a_labelAngle",size:1,type:x},{name:"a_backdropColor",size:4,type:x},{name:"a_backdropShadowColor",size:4,type:x},{name:"a_backdropShadowBlur",size:1,type:x},{name:"a_backdropPadding",size:1,type:x},{name:"a_backdropBorderColor",size:4,type:x},{name:"a_backdropExtra",size:4,type:x},{name:"a_labelBoxOffset",size:2,type:x}],CONSTANT_ATTRIBUTES:[{name:"a_quadCorner",size:2,type:x}],CONSTANT_DATA:[[-1,-1],[1,-1],[-1,1],[1,1]]}}},{key:"processBackdrop",value:function(T,x){var _=this.floats,S=this.STRIDE,A=T*S;_[A++]=x.nodeIndex,_[A++]=x.labelWidth,_[A++]=x.labelHeight,_[A++]=x.textHeight,_[A++]=pt[x.position],_[A++]=x.labelAngle,_[A++]=x.backdropColor[0],_[A++]=x.backdropColor[1],_[A++]=x.backdropColor[2],_[A++]=x.backdropColor[3],_[A++]=x.backdropShadowColor[0],_[A++]=x.backdropShadowColor[1],_[A++]=x.backdropShadowColor[2],_[A++]=x.backdropShadowColor[3],_[A++]=x.backdropShadowBlur,_[A++]=x.backdropPadding,_[A++]=x.backdropBorderColor[0],_[A++]=x.backdropBorderColor[1],_[A++]=x.backdropBorderColor[2],_[A++]=x.backdropBorderColor[3],_[A++]=x.backdropBorderWidth,_[A++]=x.backdropCornerRadius,_[A++]=x.backdropLabelPadding,_[A++]=x.backdropArea,_[A++]=x.labelBoxOffset[0],_[A++]=x.labelBoxOffset[1]}},{key:"setUniforms",value:function(T,x){var _=x.gl,S=x.uniformLocations;_.uniformMatrix3fv(S.u_matrix,!1,T.matrix),_.uniform1f(S.u_sizeRatio,T.sizeRatio),_.uniform1f(S.u_correctionRatio,T.correctionRatio),_.uniform1f(S.u_cameraAngle,T.cameraAngle),_.uniform2f(S.u_resolution,T.width*T.pixelRatio,T.height*T.pixelRatio),_.uniform1f(S.u_pixelRatio,T.pixelRatio),_.uniform1f(S.u_labelMargin,y.labelMargin),_.uniform1f(S.u_zoomLabelSizeRatio,1/f(T.zoomRatio)),_.uniform1f(S.u_labelPixelSnapping,T.labelPixelSnapping),_.uniform1i(S.u_nodeDataTexture,T.nodeDataTextureUnit),_.uniform1i(S.u_nodeDataTextureWidth,T.nodeDataTextureWidth),_.uniform1i(S.u_nodeFrameTexture,T.nodeFrameTextureUnit),_.uniform1i(S.u_nodeFrameTextureWidth,T.nodeFrameTextureWidth);var A=d();S.u_layerAttributeTexture&&A&&(A.bind(Be),_.uniform1i(S.u_layerAttributeTexture,Be),_.uniform1i(S.u_layerAttributeTextureWidth,A.getTextureWidth()),_.uniform1i(S.u_layerAttributeTexelsPerNode,A.getTexelsPerItem()));var R=z(Ut(l)),w;try{for(R.s();!(w=R.n()).done;){var F=w.value;this.setTypedUniform(F,x)}}catch(D){R.e(D)}finally{R.f()}}},{key:"hasNothingToRender",value:function(){return this.totalBackdropCount===0}},{key:"drawWebGL",value:function(T,x){var _=x.gl;this.totalBackdropCount!==0&&(this.isInstanced?_.drawArraysInstanced(T,0,this.VERTICES,this.totalBackdropCount):_.drawArrays(T,0,this.totalBackdropCount*this.VERTICES))}},{key:"reallocate",value:function(T){this.totalBackdropCount=T,T>this.bufferCapacity&&(this.bufferCapacity=Math.max(T,Math.ceil(this.bufferCapacity*1.5)||10),se(y,"reallocate",this,3)([this.bufferCapacity]))}}])}(Ze);return E(p,"labelMargin",c),new p(n,a,t)}var fi=function(n){function a(){var t;Y(this,a);for(var e=arguments.length,r=new Array(e),i=0;i<e;i++)r[i]=arguments[i];return t=te(this,a,[].concat(r)),E(t,"totalCharacterCount",0),E(t,"bufferCapacity",0),t}return ne(a,n),K(a,[{key:"processLabel",value:function(e,r,i){if(i.hidden||!i.text)return 0;for(var o=i.text,s=o.length,l=0;l<s;l++){var u=o[l];this.processCharacter(r+l,i,u,l)}return s}},{key:"hasNothingToRender",value:function(){return this.totalCharacterCount===0}},{key:"drawWebGL",value:function(e,r){var i=r.gl;this.totalCharacterCount!==0&&(this.isInstanced?i.drawArraysInstanced(e,0,this.VERTICES,this.totalCharacterCount):i.drawArrays(e,0,this.totalCharacterCount*this.VERTICES))}},{key:"reallocate",value:function(e){this.totalCharacterCount=e,e>this.bufferCapacity&&(this.bufferCapacity=Math.max(e,Math.ceil(this.bufferCapacity*1.5)||1e3),se(a,"reallocate",this,3)([this.bufferCapacity]))}}])}(Ze);function yu(){var n=`#version 300 es

in float a_nodeIndex;
in vec4 a_id;
in vec4 a_color;
in float a_labelWidth;
in float a_labelHeight;
in float a_textHeight;
in float a_positionMode;
in float a_labelAngle;
in float a_padding;
in vec2 a_quadCorner;

uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_correctionRatio;
uniform float u_cameraAngle;
uniform vec2 u_resolution;
uniform float u_pixelRatio;
uniform float u_labelMargin;
uniform float u_zoomLabelSizeRatio;
uniform float u_labelPixelSnapping;
uniform float u_pickingPadding;
uniform sampler2D u_nodeDataTexture;
uniform int u_nodeDataTextureWidth;
uniform sampler2D u_nodeFrameTexture;
uniform int u_nodeFrameTextureWidth;

out vec4 v_id;
out vec4 v_color;

`.concat(Ne,`
`).concat(Ke,`
`).concat(yt,`
`).concat(ui,`

void main() {
  int nodeIdx = int(a_nodeIndex);

  // Node data: (x, y, size, shapeId).
  vec4 nodeData = readNodeData(u_nodeDataTexture, u_nodeDataTextureWidth, nodeIdx);
  vec2 nodePosition = nodeData.xy;
  float nodeSize = nodeData.z;

  // Shape-aware edge distance, read once from the shared frame texture.
  float edgeDist = readFrameTexel(u_nodeFrameTexture, u_nodeFrameTextureWidth, nodeIdx).r;

  // Per-node label rotation alignment: 0 = viewport, 1 = label turns with camera.
  float labelRotation = readNodeFlags(u_nodeDataTexture, u_nodeDataTextureWidth, nodeIdx).g;

  `).concat(si,`

  float zoomScale = u_zoomLabelSizeRatio;
  float labelW = a_labelWidth * zoomScale * u_pixelRatio;
  float labelH = a_labelHeight * zoomScale * u_pixelRatio;
  float labelMargin = u_labelMargin * zoomScale * u_pixelRatio;
#ifdef PICKING_MODE
  float padding = u_pickingPadding * u_pixelRatio;
#else
  float padding = a_padding * u_pixelRatio;
#endif

  if (labelW <= 0.0) {
    gl_Position = vec4(2.0, 0.0, 0.0, 1.0);
    v_id = vec4(0.0);
    v_color = vec4(0.0);
    return;
  }

  vec2 labelHalfSize = vec2(labelW * 0.5 + padding, labelH * 0.5 + padding);
  vec2 labelOffset = vec2(0.0);

  // Graph-aligned labels add the camera angle so the rect orbits with the text.
  float labelAngle = a_labelAngle - labelRotation * u_cameraAngle;
  float la_c = cos(labelAngle);
  float la_s = sin(labelAngle);
  mat2 labelRotMat = mat2(la_c, -la_s, la_s, la_c);

  vec3 nodeClip = u_matrix * vec3(nodePosition, 1.0);
  vec2 nodeScreen = vec2(
    (nodeClip.x + 1.0) * u_resolution.x,
    (1.0 - nodeClip.y) * u_resolution.y
  ) * 0.5;
  vec2 snapDelta = (round(nodeScreen) - nodeScreen) * u_labelPixelSnapping;

  if (a_positionMode < 4.0) {
    float labelStart = nodeRadiusPixels * edgeDist + labelMargin;
    float textHalf = a_textHeight * zoomScale * u_pixelRatio * 0.5;
    // Box center uses the text half-size; the padding expands the quad below.
    labelOffset = labelRotMat * labelBoxCenter(a_positionMode, labelStart, vec2(labelW * 0.5, labelH * 0.5), textHalf);
  }

  // Rotate the rect with the label so it stays aligned with the (rotated) text.
  vec2 localPos = labelOffset + labelRotMat * (a_quadCorner * labelHalfSize);
  vec2 ndcOffset = (localPos + snapDelta) * 2.0 / u_resolution;
  ndcOffset.y = -ndcOffset.y;

  gl_Position = vec4(nodeClip.xy + ndcOffset, 0.0, 1.0);
  v_id = a_id;
  v_color = a_color;
}
`);return n}var bu=`#version 300 es
precision highp float;

in vec4 v_id;
in vec4 v_color;

out vec4 fragColor;

void main() {
  #ifdef PICKING_MODE
    fragColor = v_id;
  #else
    if (v_color.a <= 0.0) discard;
    // v_color is non-premultiplied RGBA (0-1); convert to premultiplied for blending
    fragColor = vec4(v_color.rgb * v_color.a, v_color.a);
  #endif
}
`;function xu(n,a,t,e){var r,i,o=e.label,s=o===void 0?{}:o,l=(r=s.margin)!==null&&r!==void 0?r:mt,u=(i=s.zoomToLabelSizeRatioFunction)!==null&&i!==void 0?i:function(){return 1},d=yu(),h=function(c){function f(){var g;Y(this,f);for(var m=arguments.length,p=new Array(m),v=0;v<m;v++)p[v]=arguments[v];return g=te(this,f,[].concat(p)),E(g,"totalCount",0),E(g,"bufferCapacity",0),g}return ne(f,c),K(f,[{key:"getDefinition",value:function(){var m=WebGL2RenderingContext,p=m.FLOAT,v=m.UNSIGNED_BYTE,y=m.TRIANGLE_STRIP;return{VERTICES:4,VERTEX_SHADER_SOURCE:d,FRAGMENT_SHADER_SOURCE:bu,METHOD:y,UNIFORMS:["u_matrix","u_sizeRatio","u_correctionRatio","u_cameraAngle","u_resolution","u_pixelRatio","u_labelMargin","u_zoomLabelSizeRatio","u_labelPixelSnapping","u_pickingPadding","u_nodeDataTexture","u_nodeDataTextureWidth","u_nodeFrameTexture","u_nodeFrameTextureWidth"],ATTRIBUTES:[{name:"a_nodeIndex",size:1,type:p},{name:"a_id",size:4,type:v,normalized:!0},{name:"a_color",size:4,type:v,normalized:!0},{name:"a_labelWidth",size:1,type:p},{name:"a_labelHeight",size:1,type:p},{name:"a_textHeight",size:1,type:p},{name:"a_positionMode",size:1,type:p},{name:"a_labelAngle",size:1,type:p},{name:"a_padding",size:1,type:p}],CONSTANT_ATTRIBUTES:[{name:"a_quadCorner",size:2,type:p}],CONSTANT_DATA:[[-1,-1],[1,-1],[-1,1],[1,1]]}}},{key:"processLabelBackground",value:function(m,p){var v=this.floats,y=this.ints,b=m*this.STRIDE;v[b++]=p.nodeIndex,y[b++]=p.id,v[b++]=p.color,v[b++]=p.labelWidth,v[b++]=p.labelHeight,v[b++]=p.textHeight,v[b++]=p.positionMode,v[b++]=p.labelAngle,v[b++]=p.padding}},{key:"setUniforms",value:function(m,p){var v=p.gl,y=p.uniformLocations;v.uniformMatrix3fv(y.u_matrix,!1,m.matrix),v.uniform1f(y.u_sizeRatio,m.sizeRatio),v.uniform1f(y.u_correctionRatio,m.correctionRatio),v.uniform1f(y.u_cameraAngle,m.cameraAngle),v.uniform2f(y.u_resolution,m.width*m.pixelRatio,m.height*m.pixelRatio),v.uniform1f(y.u_pixelRatio,m.pixelRatio),v.uniform1f(y.u_labelMargin,f.labelMargin),v.uniform1f(y.u_zoomLabelSizeRatio,1/u(m.zoomRatio)),v.uniform1f(y.u_labelPixelSnapping,m.labelPixelSnapping),v.uniform1f(y.u_pickingPadding,m.labelPickingPadding),v.uniform1i(y.u_nodeDataTexture,m.nodeDataTextureUnit),v.uniform1i(y.u_nodeDataTextureWidth,m.nodeDataTextureWidth),v.uniform1i(y.u_nodeFrameTexture,m.nodeFrameTextureUnit),v.uniform1i(y.u_nodeFrameTextureWidth,m.nodeFrameTextureWidth)}},{key:"hasNothingToRender",value:function(){return this.totalCount===0}},{key:"drawWebGL",value:function(m,p){var v=p.gl;this.totalCount!==0&&v.drawArraysInstanced(v.TRIANGLE_STRIP,0,this.VERTICES,this.totalCount)}},{key:"reallocate",value:function(m){this.totalCount=m,m>this.bufferCapacity&&(this.bufferCapacity=Math.max(m,Math.ceil(this.bufferCapacity*1.5)||10),se(f,"reallocate",this,3)([this.bufferCapacity]))}}])}(Ze);return E(h,"labelMargin",l),new h(n,a,t)}var we={fontSize:64,buffer:8,radius:24,cutoff:.25,maxTextureSize:2048,debounceTimeout:100},Gt=2,zt=1e20;function _u(n,a,t,e,r){var i=n+r*4,o=document.createElement("canvas");o.width=i,o.height=i;var s=o.getContext("2d",{willReadFrequently:!0});return s.font="".concat(e," ").concat(t," ").concat(n,"px ").concat(a),s.textBaseline="alphabetic",s.textAlign="left",s.fillStyle="black",{ctx:s,canvasSize:i,gridOuter:new Float64Array(i*i),gridInner:new Float64Array(i*i),f:new Float64Array(i),z:new Float64Array(i+1),v:new Uint16Array(i)}}function Tu(n,a,t,e,r){var i=n.ctx,o=n.canvasSize,s=i.measureText(a),l=s.width,u=s.actualBoundingBoxAscent,d=s.actualBoundingBoxDescent,h=s.actualBoundingBoxLeft,c=s.actualBoundingBoxRight,f=Math.ceil(u),g=Math.ceil(h),m=Math.max(0,Math.min(o-t,Math.ceil(h)+Math.ceil(c))),p=Math.min(o-t,f+Math.ceil(d)),v=m+2*t,y=p+2*t,b=Math.max(v*y,0),T=new Uint8ClampedArray(b),x={data:T,width:v,height:y,glyphWidth:m,glyphHeight:p,glyphTop:f,glyphLeft:g,glyphAdvance:l};if(m===0||p===0)return x;var _=n.gridInner,S=n.gridOuter;i.clearRect(t,t,m,p),i.fillText(a,t+g,t+f);var A=i.getImageData(t,t,m,p);S.fill(zt,0,b),_.fill(0,0,b);for(var R=0;R<p;R++)for(var w=0;w<m;w++){var F=A.data[4*(R*m+w)+3]/255;if(F!==0){var D=(R+t)*v+w+t;if(F===1)S[D]=0,_[D]=zt;else{var I=.5-F;S[D]=I>0?I*I:0,_[D]=I<0?I*I:0}}}Kr(S,0,0,v,y,v,n.f,n.v,n.z),Kr(_,t,t,m,p,v,n.f,n.v,n.z);for(var C=0;C<b;C++){var k=Math.sqrt(S[C])-Math.sqrt(_[C]);T[C]=Math.round(255-255*(k/e+r))}return x}function Kr(n,a,t,e,r,i,o,s,l){for(var u=a;u<a+e;u++)Zr(n,t*i+u,i,r,o,s,l);for(var d=t;d<t+r;d++)Zr(n,d*i+a,1,e,o,s,l)}function Zr(n,a,t,e,r,i,o){i[0]=0,o[0]=-zt,o[1]=zt,r[0]=n[a];for(var s=1,l=0,u=0;s<e;s++){r[s]=n[a+s*t];var d=s*s;do{var h=i[l];u=(r[s]-r[h]+d-h*h)/(s-h)/2}while(u<=o[l]&&--l>-1);l++,i[l]=s,o[l]=u,o[l+1]=zt}for(var c=0,f=0;c<e;c++){for(;o[f+1]<c;)f++;var g=i[f],m=c-g;n[a+c*t]=r[g]+m*m}}var Ye=function(n){function a(){var t,e=arguments.length>0&&arguments[0]!==void 0?arguments[0]:{};return Y(this,a),t=te(this,a),E(t,"fonts",new Map),E(t,"textures",[]),E(t,"cursor",{x:0,y:0,rowHeight:0,atlasIndex:0}),E(t,"pendingGlyphs",[]),E(t,"debounceTimer",null),t.options=W(W({},we),e),t.canvas=document.createElement("canvas"),t.canvas.width=t.options.maxTextureSize,t.canvas.height=t.options.maxTextureSize,t.ctx=t.canvas.getContext("2d",{willReadFrequently:!0}),t.measureCanvas=document.createElement("canvas"),t.measureCtx=t.measureCanvas.getContext("2d"),t.textures.push(t.ctx.getImageData(0,0,1,1)),t}return ne(a,n),K(a,[{key:"getFontKey",value:function(e){return"".concat(e.family,"-").concat(e.weight,"-").concat(e.style)}},{key:"registerFont",value:function(e){var r=this.getFontKey(e);if(this.fonts.has(r))return r;var i=_u(this.options.fontSize,e.family,e.weight,e.style,this.options.buffer);return this.fonts.set(r,{descriptor:e,generator:i,glyphs:new Map}),r}},{key:"ensureGlyphs",value:function(e,r){var i=this.fonts.get(r);if(!i)throw new Error('Font "'.concat(r,'" is not registered. Call registerFont() first.'));var o=!1,s=z(e),l;try{for(s.s();!(l=s.n()).done;){var u=l.value,d=u.codePointAt(0);d!==void 0&&(i.glyphs.has(d)||(this.pendingGlyphs.push({fontKey:r,charCode:d}),o=!0))}}catch(h){s.e(h)}finally{s.f()}o&&this.scheduleTextureGeneration()}},{key:"measureText",value:function(e,r){var i=this.fonts.get(r);if(!i)throw new Error('Font "'.concat(r,'" is not registered.'));var o=i.descriptor,s=o.family,l=o.weight,u=o.style;return this.measureCtx.font="".concat(u," ").concat(l," ").concat(this.options.fontSize,"px ").concat(s),this.measureCtx.measureText(e).width}},{key:"getGlyph",value:function(e,r){var i=this.fonts.get(r);if(i)return i.glyphs.get(e)}},{key:"getTextures",value:function(){return this.textures}},{key:"getFontCount",value:function(){return this.fonts.size}},{key:"getGlyphCount",value:function(){var e=0,r=z(this.fonts.values()),i;try{for(r.s();!(i=r.n()).done;){var o=i.value;e+=o.glyphs.size}}catch(s){r.e(s)}finally{r.f()}return e}},{key:"hasPendingGlyphs",value:function(){return this.pendingGlyphs.length>0}},{key:"flush",value:function(){this.debounceTimer&&(clearTimeout(this.debounceTimer),this.debounceTimer=null),this.generateTextures()}},{key:"destroy",value:function(){this.debounceTimer&&clearTimeout(this.debounceTimer),this.fonts.clear(),this.textures=[],this.pendingGlyphs=[],this.removeAllListeners()}},{key:"scheduleTextureGeneration",value:function(){var e=this;this.debounceTimer===null&&(this.options.debounceTimeout===null?this.generateTextures():this.debounceTimer=setTimeout(function(){e.debounceTimer=null,e.generateTextures()},this.options.debounceTimeout))}},{key:"generateTextures",value:function(){if(this.pendingGlyphs.length!==0){var e=this.options,r=e.maxTextureSize,i=e.buffer,o=e.radius,s=e.cutoff,l=z(this.pendingGlyphs),u;try{for(l.s();!(u=l.n()).done;){var d=u.value,h=d.fontKey,c=d.charCode,f=this.fonts.get(h);if(!(!f||f.glyphs.has(c))){var g=String.fromCodePoint(c),m=Tu(f.generator,g,i,o,s),p=m.width,v=m.height;this.cursor.x+p+Gt>r&&(this.cursor.x=0,this.cursor.y+=this.cursor.rowHeight+Gt,this.cursor.rowHeight=0),this.cursor.y+v+Gt>r&&(this.finalizeCurrentTexture(),this.cursor={x:0,y:0,rowHeight:0,atlasIndex:this.cursor.atlasIndex+1},this.ctx.clearRect(0,0,r,r));for(var y=m.data,b=new Uint8ClampedArray(p*v*4),T=0;T<y.length;T++){var x=T*4;b[x]=255,b[x+1]=255,b[x+2]=255,b[x+3]=y[T]}var _=new ImageData(b,p,v);this.ctx.putImageData(_,this.cursor.x,this.cursor.y);var S={charCode:c,width:m.glyphWidth,height:m.glyphHeight,bearingX:-m.glyphLeft-i,bearingY:m.glyphTop+i,advance:m.glyphAdvance,atlasX:this.cursor.x,atlasY:this.cursor.y,atlasWidth:p,atlasHeight:v,atlasIndex:this.cursor.atlasIndex};f.glyphs.set(c,S),this.cursor.x+=p+Gt,this.cursor.rowHeight=Math.max(this.cursor.rowHeight,v)}}}catch(A){l.e(A)}finally{l.f()}this.finalizeCurrentTexture(),this.pendingGlyphs=[],this.emit(a.ATLAS_UPDATED_EVENT,{textures:this.textures,glyphCount:this.getGlyphCount()})}}},{key:"finalizeCurrentTexture",value:function(){var e=this.options.maxTextureSize,r=this.cursor.y>0||this.cursor.rowHeight>0,i=Math.min(e,Math.max(this.cursor.x,r?e:1)),o=Math.min(e,this.cursor.y+this.cursor.rowHeight+Gt),s=this.ctx.getImageData(0,0,i,o);this.cursor.atlasIndex>=this.textures.length?this.textures.push(s):this.textures[this.cursor.atlasIndex]=s}}])}(ni.EventEmitter);E(Ye,"ATLAS_UPDATED_EVENT","atlasUpdated");var Eu=we.fontSize;function Su(){var n=`  // -------------------------------------------------------------------------
  // Step 3: Calculate position offset from the shared edge distance
  // -------------------------------------------------------------------------
  vec2 positionOffset = vec2(0.0);

  if (a_positionMode < 4.0) {
    vec2 screenDir = getLabelDirection(a_positionMode);
    float boundaryDistPixels = nodeRadiusPixels * edgeDist;
    positionOffset = screenDir * (boundaryDistPixels + margin);
  }`,a=`#version 300 es

// ============================================================================
// Attributes
// ============================================================================

// Per-character (instanced)
in float a_nodeIndex;        // Index into node data texture
in vec2 a_charOffset;        // Character offset from label origin (pixels)
in vec2 a_charSize;          // Character dimensions (pixels)
in vec4 a_texCoords;         // Atlas coords: (x, y, width, height) in pixels
in vec4 a_color;             // Text color (RGBA)
in float a_margin;           // Gap between node edge and label (pixels)
in float a_positionMode;     // Position: 0=right, 1=left, 2=above, 3=below, 4=over
in float a_labelWidth;       // Total label width (pixels)
in float a_labelHeight;      // Label height (pixels)
in float a_verticalCenter;   // Vertical center offset from baseline (pixels)
in float a_textHeight;       // Actual text height: maxAscent + maxDescent (pixels)
in float a_labelAngle;       // Label rotation angle (radians)

// Per-vertex (constant quad corners)
in vec2 a_quadCorner;        // Quad corner: [-1,-1], [1,-1], [-1,1], [1,1]

// ============================================================================
// Uniforms
// ============================================================================

uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_correctionRatio;
uniform float u_cameraAngle;
uniform vec2 u_resolution;
uniform vec2 u_atlasSize;
uniform sampler2D u_nodeDataTexture;
uniform int u_nodeDataTextureWidth;
uniform sampler2D u_nodeFrameTexture;
uniform int u_nodeFrameTextureWidth;
uniform float u_zoomLabelSizeRatio;
uniform float u_labelPixelSnapping;
uniform float u_pixelRatio;

// ============================================================================
// Varyings
// ============================================================================

out vec2 v_texCoord;
out vec4 v_color;
out float v_fontScale;

// ============================================================================
// Constants
// ============================================================================

const float bias = 255.0 / 254.0;
const float ATLAS_FONT_SIZE = `.concat(re(Eu),`;

// ============================================================================
// Helper Functions
// ============================================================================

`).concat(Ne,`
`).concat(Ke,`
`).concat(yt,`
`).concat(li,`

// ============================================================================
// Main
// ============================================================================

void main() {
  // -------------------------------------------------------------------------
  // Step 0: Fetch node data + shared edge distance from textures
  // -------------------------------------------------------------------------
  // Node-data texture format: vec4(x, y, size, shapeId)
  // 2D texture layout: texCoord = (index % width, index / width)
  int nodeIdx = int(a_nodeIndex);
  vec4 nodeData = readNodeData(u_nodeDataTexture, u_nodeDataTextureWidth, nodeIdx);
  vec2 a_anchorPosition = nodeData.xy;
  float a_nodeSize = nodeData.z;

  // Normalized edge distance from the shared frame texture (the frame-pass ran
  // the SDF search once; the label just reads the result).
  float edgeDist = readFrameTexel(u_nodeFrameTexture, u_nodeFrameTextureWidth, nodeIdx).r;

  // Per-node label rotation alignment: 0 = viewport, 1 = label turns with camera.
  float labelRotation = readNodeFlags(u_nodeDataTexture, u_nodeDataTextureWidth, nodeIdx).g;

  // Apply zoom-dependent label size scaling
  // Positional values are in CSS pixels; multiply by u_pixelRatio to convert to
  // physical pixels, which is what the NDC conversion (/ u_resolution) expects.
  float zoomScale = u_zoomLabelSizeRatio;
  float margin = a_margin * zoomScale * u_pixelRatio;
  vec2 charOffset = a_charOffset * zoomScale * u_pixelRatio;
  vec2 charSize = a_charSize * zoomScale * u_pixelRatio;
  float labelWidth = a_labelWidth * zoomScale * u_pixelRatio;
  float labelHeight = a_labelHeight * zoomScale;

  // Font scale: ratio of CSS label size to the base atlas font size.
  // Divided by u_pixelRatio because the atlas is generated at ATLAS_FONT_SIZE * pixelRatio,
  // which cancels out the u_pixelRatio in the fragment shader's gamma formula and keeps
  // the anti-aliasing band width consistent across pixel densities.
  v_fontScale = a_labelHeight * zoomScale / (ATLAS_FONT_SIZE * u_pixelRatio);

  // -------------------------------------------------------------------------
  // Step 1: Transform node position to clip space
  // -------------------------------------------------------------------------
  vec3 anchorClip = u_matrix * vec3(a_anchorPosition, 1.0);

  // -------------------------------------------------------------------------
  // Step 2: Convert node size to screen pixels
  // -------------------------------------------------------------------------
  float matrixScaleX = length(vec2(u_matrix[0][0], u_matrix[1][0]));
  float nodeRadiusGraphSpace = a_nodeSize * u_correctionRatio / u_sizeRatio * 2.0;
  float nodeRadiusNDC = nodeRadiusGraphSpace * matrixScaleX;
  float nodeRadiusPixels = nodeRadiusNDC * u_resolution.x / 2.0;

`).concat(n,`

  // -------------------------------------------------------------------------
  // Step 4: Calculate final vertex position
  // -------------------------------------------------------------------------
  vec2 cornerOffset = (a_quadCorner + 1.0) * 0.5;
  vec2 charPixelPos = positionOffset + charOffset + cornerOffset * charSize;

  // Apply text alignment based on position mode
  float verticalCenter = a_verticalCenter * zoomScale * u_pixelRatio;
  float textHeight = a_textHeight * zoomScale * u_pixelRatio;
  float baselineToDescent = textHeight / 2.0 - verticalCenter;
  float baselineToAscent = textHeight / 2.0 + verticalCenter;

  if (a_positionMode < 0.5) {
    // Right: vertically center
    charPixelPos.y += verticalCenter;
  } else if (a_positionMode < 1.5) {
    // Left: right-align and vertically center
    charPixelPos.x -= labelWidth;
    charPixelPos.y += verticalCenter;
  } else if (a_positionMode < 2.5) {
    // Above: center horizontally, bottom of text at anchor
    charPixelPos.x -= labelWidth * 0.5;
    charPixelPos.y -= baselineToDescent;
  } else if (a_positionMode < 3.5) {
    // Below: center horizontally, top of text at anchor
    charPixelPos.x -= labelWidth * 0.5;
    charPixelPos.y += baselineToAscent;
  } else {
    // Over: center both
    charPixelPos.x -= labelWidth * 0.5;
    charPixelPos.y += verticalCenter;
  }

  // Apply label angle rotation. Graph-aligned labels add the camera angle so the
  // whole label orbits the node in lockstep with the frame-pass edge distance.
  float labelAngle = a_labelAngle - labelRotation * u_cameraAngle;
  float la_c = cos(labelAngle);
  float la_s = sin(labelAngle);
  mat2 labelRotMat = mat2(la_c, -la_s, la_s, la_c);
  charPixelPos = labelRotMat * charPixelPos;

  // Snap node center to pixel grid so label/backdrop/attachment move as a unit
  vec2 nodeScreen = vec2(
    (anchorClip.x + 1.0) * u_resolution.x,
    (1.0 - anchorClip.y) * u_resolution.y
  ) * 0.5;
  charPixelPos += (round(nodeScreen) - nodeScreen) * u_labelPixelSnapping;

  // Convert to NDC (flip Y: screen Y-down -> clip Y-up)
  vec2 ndcOffset = vec2(charPixelPos.x, -charPixelPos.y) * 2.0 / u_resolution;
  gl_Position = vec4(anchorClip.xy + ndcOffset, 0.0, 1.0);

  // -------------------------------------------------------------------------
  // Step 5: Texture coordinates
  // -------------------------------------------------------------------------
  v_texCoord = (a_texCoords.xy + cornerOffset * a_texCoords.zw) / u_atlasSize;

  // -------------------------------------------------------------------------
  // Step 6: Pass color
  // -------------------------------------------------------------------------
  v_color = a_color;
  v_color.a *= bias;
}
`);return a}function Au(){var n=`#version 300 es
precision highp float;

in vec2 v_texCoord;
in vec4 v_color;
in float v_fontScale;

uniform sampler2D u_atlas;
uniform float u_gamma;
uniform float u_sdfBuffer;
uniform float u_pixelRatio;

// Fragment output (single target - picking handled via separate pass)
out vec4 fragColor;

void main() {
  #ifdef PICKING_MODE
    // Labels are not pickable - discard all fragments in picking mode
    fragColor = vec4(0.0);
    discard;
  #else
    // Sample SDF value from atlas (high = inside glyph, low = outside)
    float sdfValue = texture(u_atlas, v_texCoord).a;

    // Edge threshold: 1.0 - cutoff = 0.75 for default cutoff=0.25
    // This is where the glyph edge is located in the SDF
    float edgeThreshold = 1.0 - u_sdfBuffer;

    // Gamma controls the anti-aliasing band width.
    // Scale inversely with font scale so small labels get a wider AA band
    // (smoother) and large labels get a tighter band (sharper).
    float gamma = u_gamma / (u_pixelRatio * v_fontScale);

    // Pure gamma-based anti-aliasing using smoothstep
    // The AA band extends from (threshold - gamma) to (threshold + gamma)
    float alpha = smoothstep(edgeThreshold - gamma, edgeThreshold + gamma, sdfValue);

    // Premultiplied alpha output for correct blending
    float finalAlpha = v_color.a * alpha;
    fragColor = vec4(v_color.rgb * finalAlpha, finalAlpha);
  #endif
}
`;return n}function wu(){return["u_matrix","u_sizeRatio","u_correctionRatio","u_cameraAngle","u_resolution","u_atlasSize","u_atlas","u_gamma","u_sdfBuffer","u_pixelRatio","u_nodeDataTexture","u_nodeDataTextureWidth","u_nodeFrameTexture","u_nodeFrameTextureWidth","u_zoomLabelSizeRatio","u_labelPixelSnapping"]}function Du(){return{vertexShader:Su(),fragmentShader:Au(),uniforms:wu()}}function Ru(n,a,t,e){var r,i,o=e.label,s=o===void 0?{}:o,l=(r=s.margin)!==null&&r!==void 0?r:mt,u=(i=s.zoomToLabelSizeRatioFunction)!==null&&i!==void 0?i:function(){return 1},d=Du(),h=function(c){function f(g,m,p){var v,y,b,T;if(Y(this,f),T=te(this,f,[g,m,p]),E(T,"atlasTexture",null),E(T,"atlasNeedsUpdate",!1),E(T,"labelGlyphCache",new Map),T.atlasFontSize=we.fontSize*Nt(),T.atlasManager=new Ye({fontSize:T.atlasFontSize}),T.gamma=.025,T.sdfBuffer=we.cutoff,T.atlasTexture=g.createTexture(),!T.atlasTexture)throw new Error("NodeLabelProgram: failed to create atlas texture");g.bindTexture(g.TEXTURE_2D,T.atlasTexture),g.texParameteri(g.TEXTURE_2D,g.TEXTURE_WRAP_S,g.CLAMP_TO_EDGE),g.texParameteri(g.TEXTURE_2D,g.TEXTURE_WRAP_T,g.CLAMP_TO_EDGE),g.texParameteri(g.TEXTURE_2D,g.TEXTURE_MIN_FILTER,g.LINEAR),g.texParameteri(g.TEXTURE_2D,g.TEXTURE_MAG_FILTER,g.LINEAR),g.bindTexture(g.TEXTURE_2D,null),T.atlasManager.on(Ye.ATLAS_UPDATED_EVENT,function(){T.atlasNeedsUpdate=!0});var x={family:((v=s.font)===null||v===void 0?void 0:v.family)||"sans-serif",weight:((y=s.font)===null||y===void 0?void 0:y.weight)||"normal",style:((b=s.font)===null||b===void 0?void 0:b.style)||"normal"};return T.defaultFontKey=T.atlasManager.registerFont(x),T}return ne(f,c),K(f,[{key:"getDefinition",value:function(){var m=WebGL2RenderingContext,p=m.FLOAT,v=m.UNSIGNED_BYTE,y=m.TRIANGLE_STRIP;return{VERTICES:4,VERTEX_SHADER_SOURCE:d.vertexShader,FRAGMENT_SHADER_SOURCE:d.fragmentShader,METHOD:y,UNIFORMS:d.uniforms,ATTRIBUTES:[{name:"a_nodeIndex",size:1,type:p},{name:"a_charOffset",size:2,type:p},{name:"a_charSize",size:2,type:p},{name:"a_texCoords",size:4,type:p},{name:"a_color",size:4,type:v,normalized:!0},{name:"a_margin",size:1,type:p},{name:"a_positionMode",size:1,type:p},{name:"a_labelWidth",size:1,type:p},{name:"a_labelHeight",size:1,type:p},{name:"a_verticalCenter",size:1,type:p},{name:"a_textHeight",size:1,type:p},{name:"a_labelAngle",size:1,type:p}],CONSTANT_ATTRIBUTES:[{name:"a_quadCorner",size:2,type:p}],CONSTANT_DATA:[[-1,-1],[1,-1],[-1,1],[1,1]]}}},{key:"prepareLabelGlyphs",value:function(m,p){if(p.hidden||!p.text){this.labelGlyphCache.delete(m);return}var v=p.text,y=p.fontKey||this.defaultFontKey;this.atlasManager.ensureGlyphs(v,y);var b=[],T=[],x=0,_=0,S=0,A=z(v),R;try{for(A.s();!(R=A.n()).done;){var w=R.value,F=w.codePointAt(0);if(F===void 0){b.push(void 0),T.push(x);continue}var D=this.atlasManager.getGlyph(F,y);b.push(D),T.push(x),D&&(x+=D.advance,_=Math.max(_,D.bearingY),S=Math.max(S,D.atlasHeight-D.bearingY))}}catch(I){A.e(I)}finally{A.f()}this.labelGlyphCache.set(m,{glyphs:b,xOffsets:T,totalWidth:x,totalHeight:_+S,verticalCenterOffset:(_-S)/2})}},{key:"processCharacter",value:function(m,p,v,y){var b=this.floats,T=this.STRIDE,x=m*T,_=this.labelGlyphCache.get(p.parentKey);if(!_||!_.glyphs[y]){for(var S=0;S<T;S++)b[x+S]=0;return}var A=_.glyphs[y],R=_.xOffsets[y],w=p.size/this.atlasFontSize,F=xe(p.color),D=x;b[D++]=p.nodeIndex,b[D++]=(R+A.bearingX)*w,b[D++]=-A.bearingY*w,b[D++]=A.atlasWidth*w,b[D++]=A.atlasHeight*w,b[D++]=A.atlasX,b[D++]=A.atlasY,b[D++]=A.atlasWidth,b[D++]=A.atlasHeight,b[D++]=F,b[D++]=p.margin,b[D++]=pt[p.position],b[D++]=_.totalWidth*w,b[D++]=p.size,b[D++]=_.verticalCenterOffset*w,b[D++]=_.totalHeight*w,b[D++]=p.labelAngle}},{key:"processLabel",value:function(m,p,v){return this.prepareLabelGlyphs(m,v),se(f,"processLabel",this,3)([m,p,v])}},{key:"updateAtlasTexture",value:function(){if(this.atlasNeedsUpdate){var m=this.normalProgram.gl,p=this.atlasManager.getTextures();if(p.length!==0){var v=p[0];m.bindTexture(m.TEXTURE_2D,this.atlasTexture),m.texImage2D(m.TEXTURE_2D,0,m.RGBA,v.width,v.height,0,m.RGBA,m.UNSIGNED_BYTE,v.data),m.bindTexture(m.TEXTURE_2D,null),this.atlasNeedsUpdate=!1}}}},{key:"setUniforms",value:function(m,p){var v=p.gl,y=p.uniformLocations;v.uniformMatrix3fv(y.u_matrix,!1,m.matrix),v.uniform1f(y.u_sizeRatio,m.sizeRatio),v.uniform1f(y.u_correctionRatio,m.correctionRatio),v.uniform1f(y.u_cameraAngle,m.cameraAngle),v.uniform2f(y.u_resolution,m.width*m.pixelRatio,m.height*m.pixelRatio);var b=this.atlasManager.getTextures();b.length>0?v.uniform2f(y.u_atlasSize,b[0].width,b[0].height):v.uniform2f(y.u_atlasSize,1,1),v.activeTexture(v.TEXTURE0),v.bindTexture(v.TEXTURE_2D,this.atlasTexture),v.uniform1i(y.u_atlas,0),y.u_nodeDataTexture!==void 0&&v.uniform1i(y.u_nodeDataTexture,m.nodeDataTextureUnit),y.u_nodeDataTextureWidth!==void 0&&v.uniform1i(y.u_nodeDataTextureWidth,m.nodeDataTextureWidth),v.uniform1i(y.u_nodeFrameTexture,m.nodeFrameTextureUnit),v.uniform1i(y.u_nodeFrameTextureWidth,m.nodeFrameTextureWidth),v.uniform1f(y.u_gamma,this.gamma),v.uniform1f(y.u_sdfBuffer,this.sdfBuffer),v.uniform1f(y.u_pixelRatio,m.pixelRatio),v.uniform1f(y.u_zoomLabelSizeRatio,1/f.zoomToLabelSizeRatioFunction(m.zoomRatio)),v.uniform1f(y.u_labelPixelSnapping,m.labelPixelSnapping)}},{key:"renderProgram",value:function(m,p){this.updateAtlasTexture(),this.atlasManager.hasPendingGlyphs()&&(this.atlasManager.flush(),this.updateAtlasTexture()),se(f,"renderProgram",this,3)([m,p])}},{key:"registerFont",value:function(m){var p=arguments.length>1&&arguments[1]!==void 0?arguments[1]:"normal",v=arguments.length>2&&arguments[2]!==void 0?arguments[2]:"normal";return this.atlasManager.registerFont({family:m,weight:p,style:v})}},{key:"getAtlasManager",value:function(){return this.atlasManager}},{key:"measureLabel",value:function(m,p,v){var y=v||this.defaultFontKey;this.atlasManager.ensureGlyphs(m,y),this.atlasManager.hasPendingGlyphs()&&this.atlasManager.flush();var b=0,T=0,x=0,_=z(m),S;try{for(_.s();!(S=_.n()).done;){var A=S.value,R=A.codePointAt(0);if(R!==void 0){var w=this.atlasManager.getGlyph(R,y);w&&(b+=w.advance,T=Math.max(T,w.bearingY),x=Math.max(x,w.atlasHeight-w.bearingY))}}}catch(D){_.e(D)}finally{_.f()}var F=p/this.atlasFontSize;return{width:b*F,height:p,textHeight:(T+x)*F}}},{key:"ensureGlyphsReady",value:function(m,p){var v=p||this.defaultFontKey,y=z(m),b;try{for(y.s();!(b=y.n()).done;){var T=b.value;this.atlasManager.ensureGlyphs(T,v)}}catch(x){y.e(x)}finally{y.f()}this.atlasManager.flush()}},{key:"kill",value:function(){var m=this.normalProgram.gl;this.atlasTexture&&(m.deleteTexture(this.atlasTexture),this.atlasTexture=null),this.atlasManager.destroy(),this.labelGlyphCache.clear(),se(f,"kill",this,3)([])}}])}(fi);return E(h,"labelMargin",l),E(h,"zoomToLabelSizeRatioFunction",u),new h(n,a,t)}var Cu=`#version 300 es
precision highp float;

in float v_edgeDist;

// R32F target: only the .r channel is stored.
out vec4 fragColor;

void main() {
  fragColor = vec4(v_edgeDist, 0.0, 0.0, 0.0);
}
`;function Lu(n,a,t){var e=ma(n),r=Ut(n).map(function(g){return"uniform ".concat(g.type," ").concat(g.name,";")}).join(`
`),i=eu(n,t),o=i.code,s=i.multiShape,l=bt(n,a),u=Object.keys(l.specs).map(function(g){return"float v_".concat(g,";")}).join(`
`),d=vt(l,{varPrefix:"nodeAttr",baseTexelExpr:"nodeIdx * u_layerAttributeTexelsPerNode",textureWidthUniform:"u_layerAttributeTextureWidth",textureSamplerUniform:"u_layerAttributeTexture"}),h=d.fetchCode,c=d.varyingAssignments,f=`#version 300 es
precision highp float;

uniform float u_cameraAngle;
uniform sampler2D u_nodeDataTexture;
uniform int u_nodeDataTextureWidth;
uniform float u_frameTextureWidth;
uniform float u_frameTextureHeight;
uniform sampler2D u_layerAttributeTexture;
uniform int u_layerAttributeTextureWidth;
uniform int u_layerAttributeTexelsPerNode;
`.concat(r,`

in float a_nodeIndex;     // node-data texture index (also the target frame texel)
in float a_positionMode;  // 0=right 1=left 2=above 3=below 4=over
in float a_labelAngle;    // intrinsic label angle (radians)

out float v_edgeDist;

// Shape attributes (plain globals: this pass is vertex-only)
`).concat(u,`

`).concat(Ne,`
`).concat(Ke,`
`).concat(e,`
`).concat(o,`
`).concat(li,`

void main() {
  int nodeIdx = int(a_nodeIndex);
`).concat(h,`
`).concat(c,`
  `).concat(s?`// Multi-shape: the shape id lives in the node-data texture's .w channel:
  g_shapeId = int(readNodeData(u_nodeDataTexture, u_nodeDataTextureWidth, nodeIdx).w);`:"// Single-shape mode, shape id not needed",`

  // Per-node rotation alignment (0 = viewport, 1 = graph).
  vec4 nodeFlags = readNodeFlags(u_nodeDataTexture, u_nodeDataTextureWidth, nodeIdx);
  float nodeRotation = nodeFlags.r;
  float labelRotation = nodeFlags.g;

  // Effective angle: intrinsic (style-given) plus the camera angle when the label
  // is graph-aligned. The companions place the box at this same angle.
  float effectiveAngle = a_labelAngle - labelRotation * u_cameraAngle;

  // The "over" mode (4) sits on the node center, so it has no edge distance.
  float edgeDist = 0.0;
  if (a_positionMode < 4.0) {
    vec2 screenDir = getLabelDirection(a_positionMode);
    // Rotate by the effective label angle. Inlined rather than via rotate2D()
    // because the shape SDFs (getShapeGLSLForShapes) already define that helper
    // for multi-shape programs, and redefining it would be a GLSL error.
    float ea_c = cos(effectiveAngle);
    float ea_s = sin(effectiveAngle);
    vec2 rotatedScreenDir = mat2(ea_c, -ea_s, ea_s, ea_c) * screenDir;
    // Screen (Y-down) -> SDF (Y-up).
    vec2 sdfDir = vec2(rotatedScreenDir.x, -rotatedScreenDir.y);
    // Counter-rotate into the shape's local frame for graph-aligned nodes, so the
    // boundary is queried against the shape's actual on-screen orientation.
    float nodeCa = -u_cameraAngle * nodeRotation;
    float nc = cos(nodeCa), ns = sin(nodeCa);
    sdfDir = mat2(nc, -ns, ns, nc) * sdfDir;
    edgeDist = findEdgeDistance(sdfDir, 1.0);
  }
  v_edgeDist = edgeDist;

  // Scatter to this node's texel center in the frame texture.
  float x = mod(a_nodeIndex, u_frameTextureWidth);
  float y = floor(a_nodeIndex / u_frameTextureWidth);
  vec2 ndc = (vec2(x, y) + 0.5) / vec2(u_frameTextureWidth, u_frameTextureHeight) * 2.0 - 1.0;
  gl_Position = vec4(ndc, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`);return f}var gi=function(){function n(a,t){Y(this,n),E(this,"uniformLocations",{});var e=t.shapes,r=t.layers,i=t.shapeGlobalIds;if(e.length===0)throw new Error("NodeLabelFramePass: at least one shape must be provided");this.gl=a,this.shapeUniforms=Ut(e),this.hasAttributeData=Object.keys(bt(e,r).offsets).length>0,this.vertexShader=ga(a,Lu(e,r,i)),this.fragmentShader=va(a,Cu),this.program=pa(a,[this.vertexShader,this.fragmentShader]);var o=["u_cameraAngle","u_nodeDataTexture","u_nodeDataTextureWidth","u_frameTextureWidth","u_frameTextureHeight","u_layerAttributeTexture","u_layerAttributeTextureWidth","u_layerAttributeTexelsPerNode"].concat($(this.shapeUniforms.map(function(v){return v.name}))),s=z(o),l;try{for(s.s();!(l=s.n()).done;){var u=l.value;this.uniformLocations[u]=a.getUniformLocation(this.program,u)}}catch(v){s.e(v)}finally{s.f()}var d=n.FLOATS_PER_POINT*4;this.vao=a.createVertexArray(),this.buffer=a.createBuffer(),a.bindVertexArray(this.vao),a.bindBuffer(a.ARRAY_BUFFER,this.buffer);var h=z([["a_nodeIndex",0],["a_positionMode",4],["a_labelAngle",8]]),c;try{for(h.s();!(c=h.n()).done;){var f=Q(c.value,2),g=f[0],m=f[1],p=a.getAttribLocation(this.program,g);p>=0&&(a.enableVertexAttribArray(p),a.vertexAttribPointer(p,1,a.FLOAT,!1,d,m))}}catch(v){h.e(v)}finally{h.f()}a.bindVertexArray(null)}return K(n,[{key:"run",value:function(t,e,r,i,o){if(e!==0){var s=this.gl;s.useProgram(this.program),s.bindVertexArray(this.vao),s.bindBuffer(s.ARRAY_BUFFER,this.buffer),s.bufferData(s.ARRAY_BUFFER,t.subarray(0,e*n.FLOATS_PER_POINT),s.DYNAMIC_DRAW);var l=this.uniformLocations;s.uniform1f(l.u_cameraAngle,i.cameraAngle),s.uniform1i(l.u_nodeDataTexture,i.nodeDataTextureUnit),s.uniform1i(l.u_nodeDataTextureWidth,i.nodeDataTextureWidth),s.uniform1f(l.u_frameTextureWidth,r.getTextureWidth()),s.uniform1f(l.u_frameTextureHeight,r.getTextureHeight()),this.hasAttributeData&&o&&(o.bind(Be),l.u_layerAttributeTexture&&s.uniform1i(l.u_layerAttributeTexture,Be),l.u_layerAttributeTextureWidth&&s.uniform1i(l.u_layerAttributeTextureWidth,o.getTextureWidth()),l.u_layerAttributeTexelsPerNode&&s.uniform1i(l.u_layerAttributeTexelsPerNode,o.getTexelsPerItem()));var u=z(this.shapeUniforms),d;try{for(u.s();!(d=u.n()).done;){var h=d.value;xa(s,this.uniformLocations[h.name],h)}}catch(c){u.e(c)}finally{u.f()}r.bindAsRenderTarget(),s.disable(s.BLEND),s.disable(s.DEPTH_TEST),s.drawArrays(s.POINTS,0,e),s.bindFramebuffer(s.FRAMEBUFFER,null),s.bindVertexArray(null)}}},{key:"kill",value:function(){var t=this.gl;t.deleteProgram(this.program),t.deleteShader(this.vertexShader),t.deleteShader(this.fragmentShader),t.deleteBuffer(this.buffer),t.deleteVertexArray(this.vao)}}])}();E(gi,"FLOATS_PER_POINT",3);function vi(n,a,t,e,r){var i,o=e.label,s=o===void 0?{}:o,l=e.shapes;if(l.length===0)throw new Error("createNodeProgram: at least one shape must be provided in 'shapes'");var u={},d=[],h;l.forEach(function(S,A){var R=$l(S);A===0&&(h=R),u[S.name]=A,d[A]=Bt(R)});var c=$(e.layers),f=Yr({shapes:l,layers:c,shapeGlobalIds:l.length>1?d:void 0,antialias:r}),g=Ru(n,null,t,{label:s}),m=mu(n,null,t,{shapes:l,layers:c,getAttributeTexture:function(){return _.getAttributeTexture()},label:s,shapeGlobalIds:l.length>1?d:void 0}),p=xu(n,a,t,{label:s}),v=e.labelAttachments&&Object.keys(e.labelAttachments).length>0?lu(n,null,t,{label:s}):null,y=new gi(n,{shapes:l,layers:c,shapeGlobalIds:l.length>1?d:void 0}),b=Fn(l,c),T=Te(b),x=(i=function(S){function A(R,w,F){var D;Y(this,A),D=te(this,A,[R,w,F]),E(D,"layerLifecycles",new Map),E(D,"layersNeedingRegeneration",new Set),E(D,"attrDescriptors",[]),D._pickingBuffer=w;var I=x.layerTextures.get(R);I||(I=new Ln(R,T),x.layerTextures.set(R,I)),D.layerAttributeTexture=I;var C=x.textureRefCounts.get(R)||0;x.textureRefCounts.set(R,C+1),D.packedAttributeData=new Float32Array(T.floatsPerItem),c.forEach(function(G,N){if(G.lifecycle){var L={gl:R,renderer:{refresh:function(){return F.refresh()}},getUniformLocation:function(H){return R.getUniformLocation(D.normalProgram.program,H)},requestShaderRegeneration:function(){D.layersNeedingRegeneration.add(N)},requestRefresh:function(){F.refresh()}},P=G.lifecycle(L);D.layerLifecycles.set(N,P)}}),D.layerLifecycles.forEach(function(G){var N;(N=G.init)===null||N===void 0||N.call(G)});var k=new Map;return D.layerLifecycles.forEach(function(G,N){G.getAttributeData&&k.set(N,G)}),D.attrDescriptors=kn(b,T,k),D}return ne(A,S),K(A,[{key:"getDefinition",value:function(){var w=WebGL2RenderingContext,F=w.FLOAT,D=w.TRIANGLE_STRIP;return{VERTICES:4,VERTEX_SHADER_SOURCE:f.vertexShader,FRAGMENT_SHADER_SOURCE:f.fragmentShader,METHOD:D,UNIFORMS:f.uniforms,ATTRIBUTES:f.attributes,CONSTANT_ATTRIBUTES:[{name:"a_quadCorner",size:2,type:F}],CONSTANT_DATA:[[-1,-1],[1,-1],[-1,1],[1,1]]}}},{key:"maybeRegenerateShaders",value:function(){var w=this;if(this.layersNeedingRegeneration.size!==0){c=c.map(function(N,L){if(w.layersNeedingRegeneration.has(L)){var P=w.layerLifecycles.get(L);if(P!=null&&P.regenerate){var M=P.regenerate();return W(W({},M),{},{lifecycle:N.lifecycle})}}return N}),this.layersNeedingRegeneration.clear(),f=Yr({shapes:l,layers:c,shapeGlobalIds:l.length>1?d:void 0,antialias:this.renderer.getSetting("antialiasNodes")});var F=this.normalProgram.gl,D=this.normalProgram,I=D.program,C=D.buffer,k=D.vertexShader,G=D.fragmentShader;F.deleteProgram(I),F.deleteBuffer(C),F.deleteShader(k),F.deleteShader(G),this.normalProgram=this.getProgramInfo("normal",F,f.vertexShader,f.fragmentShader,this._pickingBuffer)}}},{key:"allocateNode",value:function(w){this.layerAttributeTexture.allocate(w)}},{key:"freeNode",value:function(w){this.layerAttributeTexture.free(w)}},{key:"getAttributeTexture",value:function(){return this.layerAttributeTexture}},{key:"uploadLayerTexture",value:function(){this.layerAttributeTexture.upload()}},{key:"process",value:function(w,F,D,I,C){var k=F*this.STRIDE;if(D.visibility==="hidden"){for(var G=k+this.STRIDE;k<G;k++)this.floats[k]=0;this.floats[F*this.STRIDE]=di;return}this.processVisibleItem(dt(w),k,D,I,C)}},{key:"processVisibleItem",value:function(w,F,D,I,C){var k,G=this.floats,N=this.ints;if(G[F++]=I,N[F++]=w,G[F++]=(k=D.opacity)!==null&&k!==void 0?k:1,T.floatsPerItem!==0){var L=this.packedAttributeData;Pn(this.attrDescriptors,D,L,D.color,this.layerLifecycles,0),this.layerAttributeTexture.updateAllAttributes(C,L)}}},{key:"setUniforms",value:function(w,F){var D=this,I=F.gl,C=F.uniformLocations;C.u_matrix&&I.uniformMatrix3fv(C.u_matrix,!1,w.matrix),C.u_sizeRatio&&I.uniform1f(C.u_sizeRatio,w.sizeRatio),C.u_correctionRatio&&I.uniform1f(C.u_correctionRatio,w.correctionRatio),C.u_pickingPadding&&I.uniform1f(C.u_pickingPadding,w.nodePickingPadding),C.u_cameraAngle&&I.uniform1f(C.u_cameraAngle,w.cameraAngle),C.u_nodeDataTexture&&I.uniform1i(C.u_nodeDataTexture,w.nodeDataTextureUnit),C.u_nodeDataTextureWidth&&I.uniform1i(C.u_nodeDataTextureWidth,w.nodeDataTextureWidth),C.u_layerAttributeTexture&&(this.layerAttributeTexture.bind(Be),I.uniform1i(C.u_layerAttributeTexture,Be)),C.u_layerAttributeTextureWidth&&I.uniform1i(C.u_layerAttributeTextureWidth,this.layerAttributeTexture.getTextureWidth()),C.u_layerAttributeTexelsPerNode&&I.uniform1i(C.u_layerAttributeTexelsPerNode,this.layerAttributeTexture.getTexelsPerItem()),l.forEach(function(k){k.uniforms.forEach(function(G){D.setTypedUniform(G,F)})}),c.forEach(function(k){k.uniforms.forEach(function(G){D.setTypedUniform(G,F)})})}},{key:"render",value:function(w,F,D){this.maybeRegenerateShaders(),se(A,"render",this,3)([w,F,D])}},{key:"renderProgram",value:function(w,F){var D=F.gl,I=F.program;D.useProgram(I),F===this.normalProgram&&this.layerLifecycles.forEach(function(C){var k;(k=C.beforeRender)===null||k===void 0||k.call(C)}),se(A,"renderProgram",this,3)([w,F])}},{key:"kill",value:function(){this.layerLifecycles.forEach(function(D){var I;(I=D.kill)===null||I===void 0||I.call(D)}),this.layerLifecycles.clear();var w=this.normalProgram.gl,F=(x.textureRefCounts.get(w)||1)-1;F<=0?(this.layerAttributeTexture.kill(),x.layerTextures.delete(w),x.textureRefCounts.delete(w)):x.textureRefCounts.set(w,F),se(A,"kill",this,3)([])}}])}(Ze),E(i,"layerTextures",new WeakMap),E(i,"textureRefCounts",new WeakMap),i),_=new x(n,null,t);return{nodeProgram:_,labelProgram:g,backdropProgram:m,labelBackgroundProgram:p,attachmentProgram:v,framePass:y,shapeSlug:h,shapeNameToIndex:l.length>1?u:void 0,shapeGlobalIds:l.length>1?d:void 0}}var Ue=6;function Ht(n){var a=n.offsets,t=n.specs,e=n.floatsPerItem,r=Object.keys(a);if(r.length===0||e===0)return{uniformDeclarations:"",uniformNames:[],vertexVaryingDeclarations:"",fragmentVaryingDeclarations:"",fetchCode:"",varyingAssignments:""};var i=`
uniform sampler2D u_edgeAttributeTexture;
uniform int u_edgeAttributeTextureWidth;
uniform int u_edgeAttributeTexelsPerEdge;`,o=["u_edgeAttributeTexture","u_edgeAttributeTextureWidth","u_edgeAttributeTexelsPerEdge"],s=r.map(function(f){var g=t[f].size===1?"float":"vec".concat(t[f].size);return"".concat(g," v_").concat(f,";")}),l=s.map(function(f){return"out ".concat(f)}).join(`
`),u=s.map(function(f){return"in ".concat(f)}).join(`
`),d=vt(n,{varPrefix:"attr",baseTexelExpr:"edgeIdx * u_edgeAttributeTexelsPerEdge",textureWidthUniform:"u_edgeAttributeTextureWidth",textureSamplerUniform:"u_edgeAttributeTexture"}),h=d.fetchCode,c=d.varyingAssignments;return{uniformDeclarations:i,uniformNames:o,vertexVaryingDeclarations:l,fragmentVaryingDeclarations:u,fetchCode:h,varyingAssignments:c}}function ku(n){return`
float findSourceClampT_`.concat(n,`(vec2 source, float sourceSize, int sourceShapeId, float sourceRotateAlign, vec2 target, float margin) {
  float lo = 0.0, hi = 0.5;
  float nodeExtent = sourceSize * u_correctionRatio / u_sizeRatio * 2.0;
  float effectiveSize = 1.0 - u_correctionRatio / nodeExtent;

  // Counter-rotate the query point so viewport-aligned nodes (rotateAlign=0) are
  // clamped against their on-screen orientation; graph-aligned nodes skip it.
  float ca = u_cameraAngle * (1.0 - sourceRotateAlign);
  float rc = cos(ca), rs = sin(ca);
  mat2 rot = mat2(rc, -rs, rs, rc);

  for (int i = 0; i < 12; i++) {
    float mid = (lo + hi) * 0.5;
    vec2 pos = path_`).concat(n,`_position(mid, source, target);
    vec2 localPos = rot * ((pos - source) / nodeExtent);
    float sdf = querySDF(sourceShapeId, localPos, effectiveSize);
    if (sdf < 0.0) lo = mid;
    else hi = mid;
  }

  float pathLen = path_`).concat(n,`_length(source, target);
  float marginT = (margin * u_correctionRatio / u_sizeRatio) / pathLen;
  return (lo + hi) * 0.5 + marginT;
}
`)}function Pu(n){return`
float findTargetClampT_`.concat(n,`(vec2 source, vec2 target, float targetSize, int targetShapeId, float targetRotateAlign, float margin) {
  float lo = 0.5, hi = 1.0;
  float nodeExtent = targetSize * u_correctionRatio / u_sizeRatio * 2.0;
  float effectiveSize = 1.0 - u_correctionRatio / nodeExtent;

  // See findSourceClampT_ for the rotation rationale.
  float ca = u_cameraAngle * (1.0 - targetRotateAlign);
  float rc = cos(ca), rs = sin(ca);
  mat2 rot = mat2(rc, -rs, rs, rc);

  for (int i = 0; i < 12; i++) {
    float mid = (lo + hi) * 0.5;
    vec2 pos = path_`).concat(n,`_position(mid, source, target);
    vec2 localPos = rot * ((pos - target) / nodeExtent);
    float sdf = querySDF(targetShapeId, localPos, effectiveSize);
    if (sdf < 0.0) hi = mid;
    else lo = mid;
  }

  float pathLen = path_`).concat(n,`_length(source, target);
  float marginT = (margin * u_correctionRatio / u_sizeRatio) / pathLen;
  return (lo + hi) * 0.5 - marginT;
}
`)}function pi(n){return`
// Auto-generated numerical tangent (from position via finite differences)
vec2 path_`.concat(n,`_tangent(float t, vec2 source, vec2 target) {
  float epsilon = 0.001;
  float t1 = max(0.0, t - epsilon);
  float t2 = min(1.0, t + epsilon);
  vec2 p1 = path_`).concat(n,`_position(t1, source, target);
  vec2 p2 = path_`).concat(n,`_position(t2, source, target);
  return normalize(p2 - p1);
}

// Auto-generated normal (perpendicular to tangent)
vec2 path_`).concat(n,`_normal(float t, vec2 source, vec2 target) {
  vec2 tangent = path_`).concat(n,`_tangent(t, source, target);
  return vec2(-tangent.y, tangent.x);
}
`)}function Fu(n){return`
// Auto-generated path length (samples position 16 times)
float path_`.concat(n,`_length(vec2 source, vec2 target) {
  float len = 0.0;
  vec2 prev = path_`).concat(n,`_position(0.0, source, target);
  for (int i = 1; i <= 16; i++) {
    float t = float(i) / 16.0;
    vec2 curr = path_`).concat(n,`_position(t, source, target);
    len += length(curr - prev);
    prev = curr;
  }
  return len;
}
`)}function Iu(n){return`
// Auto-generated closest_t (coarse sample + ternary search)
float path_`.concat(n,`_closest_t(vec2 p, vec2 source, vec2 target) {
  // Coarse search: find best among 10 samples
  float bestT = 0.0;
  float bestDist = 1e10;
  for (int i = 0; i <= 10; i++) {
    float t = float(i) / 10.0;
    vec2 pos = path_`).concat(n,`_position(t, source, target);
    float d = length(p - pos);
    if (d < bestDist) {
      bestDist = d;
      bestT = t;
    }
  }

  // Refine with ternary search
  float lo = max(0.0, bestT - 0.1);
  float hi = min(1.0, bestT + 0.1);
  for (int i = 0; i < 10; i++) {
    float mid1 = lo + (hi - lo) / 3.0;
    float mid2 = hi - (hi - lo) / 3.0;
    float d1 = length(p - path_`).concat(n,`_position(mid1, source, target));
    float d2 = length(p - path_`).concat(n,`_position(mid2, source, target));
    if (d1 < d2) {
      hi = mid2;
    } else {
      lo = mid1;
    }
  }
  return (lo + hi) * 0.5;
}
`)}function Nu(n){return`
// Auto-generated signed distance (via closest_t + normal)
float path_`.concat(n,`_distance(vec2 p, vec2 source, vec2 target) {
  float closestT = path_`).concat(n,`_closest_t(p, source, target);
  vec2 closest = path_`).concat(n,`_position(closestT, source, target);
  vec2 diff = p - closest;
  float dist = length(diff);
  if (dist < 0.0001) return 0.0;

  // Get normal at closest point
  vec2 normal = path_`).concat(n,`_normal(closestT, source, target);
  return dist * sign(dot(diff, normal));
}
`)}function Gu(n){return`
// Auto-generated t_at_distance (binary search)
float path_`.concat(n,`_t_at_distance(float targetDist, vec2 source, vec2 target) {
  if (targetDist <= 0.0) return 0.0;

  float totalLen = path_`).concat(n,`_length(source, target);
  if (targetDist >= totalLen) return 1.0;

  // Binary search for t
  float lo = 0.0, hi = 1.0;
  for (int i = 0; i < 12; i++) {
    float mid = (lo + hi) * 0.5;

    // Compute arc length from 0 to mid
    float arcLen = 0.0;
    vec2 prev = path_`).concat(n,`_position(0.0, source, target);
    for (int j = 1; j <= 8; j++) {
      float t = mid * float(j) / 8.0;
      vec2 curr = path_`).concat(n,`_position(t, source, target);
      arcLen += length(curr - prev);
      prev = curr;
    }

    if (arcLen < targetDist) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) * 0.5;
}
`)}function Sn(n,a){var t=new RegExp("\\b(float|vec[234]|void|int|bool)\\s+".concat(a,"\\s*\\("));return t.test(n)}function mi(n,a){var t=[];return Sn(a,"path_".concat(n,"_length"))||t.push(Fu(n)),Sn(a,"path_".concat(n,"_closest_t"))||t.push(Iu(n)),Sn(a,"path_".concat(n,"_distance"))||t.push(Nu(n)),Sn(a,"path_".concat(n,"_t_at_distance"))||t.push(Gu(n)),t.length>0?`
// ============================================================================
// Auto-generated fallback functions (path only provided position)
// ============================================================================
`.concat(t.join(`
`)):""}function yi(n){var a,t,e,r=n.paths,i=n.layers,o=(a=n.extremities)!==null&&a!==void 0?a:[];if(r.length===0)throw new Error("At least one path is required in 'paths'");if(i.length===0)throw new Error("At least one layer is required in 'layers'");var s=(t=n.defaultHead)!==null&&t!==void 0?t:"none",l=(e=n.defaultTail)!==null&&e!==void 0?e:"none";return{paths:r,extremities:o,layers:i,path:r[0],layer:i[0],defaultHead:s,defaultTail:l}}var bi=WebGL2RenderingContext,Wt=bi.FLOAT,Qr=bi.UNSIGNED_BYTE;function Mu(n,a,t){var e=new Set(["u_matrix","u_sizeRatio","u_correctionRatio","u_zoomRatio","u_pixelRatio","u_cameraAngle","u_minEdgeThickness","u_pickingPadding","u_nodeDataTexture","u_nodeDataTextureWidth","u_edgeDataTexture","u_edgeDataTextureWidth","u_edgeFrameTexture","u_edgeFrameTextureWidth","u_edgeAttributeTexture","u_edgeAttributeTextureWidth","u_edgeAttributeTexelsPerEdge"]),r=new Set(e);return n.forEach(function(i){return i.uniforms.forEach(function(o){return r.add(o.name)})}),a.forEach(function(i){return i.uniforms.forEach(function(o){return r.add(o.name)})}),t.forEach(function(i){return i.uniforms.forEach(function(o){return r.add(o.name)})}),Array.from(r)}function _a(n){var a=new Set,t=[],e=z(n),r;try{for(e.s();!(r=e.n()).done;){var i=r.value;a.has(i.name)||(a.add(i.name),t.push("// Path: ".concat(i.name)),t.push(i.glsl),t.push(pi(i.name)),t.push(mi(i.name,i.glsl)))}}catch(o){e.e(o)}finally{e.f()}return t.join(`

`)}function zu(n){var a=[],t=z(n),e;try{for(t.s();!(e=t.n()).done;){var r=e.value;a.push("// Extremity: ".concat(r.name)),a.push(r.glsl)}}catch(i){t.e(i)}finally{t.f()}return a.join(`

`)}var Wu=[{queryName:"queryPathPosition",pathFunc:"position",returnType:"vec2",params:"float t, vec2 source, vec2 target",args:"t, source, target"},{queryName:"queryPathTangent",pathFunc:"tangent",returnType:"vec2",params:"float t, vec2 source, vec2 target",args:"t, source, target"},{queryName:"queryPathNormal",pathFunc:"normal",returnType:"vec2",params:"float t, vec2 source, vec2 target",args:"t, source, target"},{queryName:"queryPathLength",pathFunc:"length",returnType:"float",params:"vec2 source, vec2 target",args:"source, target"},{queryName:"queryPathClosestT",pathFunc:"closest_t",returnType:"float",params:"vec2 p, vec2 source, vec2 target",args:"p, source, target"}];function Bu(n,a){var t=a.queryName,e=a.pathFunc,r=a.returnType,i=a.params,o=a.args;if(n.length===1)return"".concat(r," ").concat(t,"(int pathId, ").concat(i,`) {
  return path_`).concat(n[0].name,"_").concat(e,"(").concat(o,`);
}`);var s=n.map(function(l,u){return"    case ".concat(u,": return path_").concat(l.name,"_").concat(e,"(").concat(o,");")}).join(`
`);return"".concat(r," ").concat(t,"(int pathId, ").concat(i,`) {
  switch (pathId) {
`).concat(s,`
    default: return path_`).concat(n[0].name,"_").concat(e,"(").concat(o,`);
  }
}`)}function Ta(n){return Wu.map(function(a){return Bu(n,a)}).join(`

`)}function Uu(n){if(n.length===1)return`float queryExtremitySDF(int extremityId, vec2 uv, float lengthRatio, float widthRatio) {
  return extremity_`.concat(n[0].name,`(uv, lengthRatio, widthRatio);
}`);var a=n.map(function(t,e){return"    case ".concat(e,": return extremity_").concat(t.name,"(uv, lengthRatio, widthRatio);")}).join(`
`);return`float queryExtremitySDF(int extremityId, vec2 uv, float lengthRatio, float widthRatio) {
  switch (extremityId) {
`.concat(a,`
    default: return extremity_`).concat(n[0].name,`(uv, lengthRatio, widthRatio);
  }
}`)}function Ou(n){var a=[],t=z(n),e;try{for(t.s();!(e=t.n()).done;){var r=e.value;a.push(ku(r.name)),a.push(Pu(r.name))}}catch(s){t.e(s)}finally{t.f()}if(n.length===1)a.push(`
float queryFindSourceClampT(int pathId, vec2 source, float sourceSize, int sourceShapeId, float sourceRotateAlign, vec2 target, float margin) {
  return findSourceClampT_`.concat(n[0].name,`(source, sourceSize, sourceShapeId, sourceRotateAlign, target, margin);
}

float queryFindTargetClampT(int pathId, vec2 source, vec2 target, float targetSize, int targetShapeId, float targetRotateAlign, float margin) {
  return findTargetClampT_`).concat(n[0].name,`(source, target, targetSize, targetShapeId, targetRotateAlign, margin);
}`));else{var i=n.map(function(s,l){return"    case ".concat(l,": return findSourceClampT_").concat(s.name,"(source, sourceSize, sourceShapeId, sourceRotateAlign, target, margin);")}).join(`
`),o=n.map(function(s,l){return"    case ".concat(l,": return findTargetClampT_").concat(s.name,"(source, target, targetSize, targetShapeId, targetRotateAlign, margin);")}).join(`
`);a.push(`
float queryFindSourceClampT(int pathId, vec2 source, float sourceSize, int sourceShapeId, float sourceRotateAlign, vec2 target, float margin) {
  switch (pathId) {
`.concat(i,`
    default: return findSourceClampT_`).concat(n[0].name,`(source, sourceSize, sourceShapeId, sourceRotateAlign, target, margin);
  }
}

float queryFindTargetClampT(int pathId, vec2 source, vec2 target, float targetSize, int targetShapeId, float targetRotateAlign, float margin) {
  switch (pathId) {
`).concat(o,`
    default: return findTargetClampT_`).concat(n[0].name,`(source, target, targetSize, targetShapeId, targetRotateAlign, margin);
  }
}`))}return a.join(`

`)}function Hu(n,a,t,e,r){var i=Te([].concat($(n),$(t))),o=Ht(i),s=bt(e,r),l=Object.keys(s.offsets),u=function(S){var A=s.specs[S].size;return A===1?"float":"vec".concat(A)},d=l.map(function(_){return"".concat(u(_)," v_source_").concat(_,`;
`).concat(u(_)," v_target_").concat(_,";")}).join(`
`),h=vt(s,{varPrefix:"srcNodeAttr",baseTexelExpr:"srcIdx * u_layerAttributeTexelsPerNode",textureWidthUniform:"u_layerAttributeTextureWidth",textureSamplerUniform:"u_layerAttributeTexture",outputPrefix:"v_source_"}),c=vt(s,{varPrefix:"tgtNodeAttr",baseTexelExpr:"tgtIdx * u_layerAttributeTexelsPerNode",textureWidthUniform:"u_layerAttributeTextureWidth",textureSamplerUniform:"u_layerAttributeTexture",outputPrefix:"v_target_"}),f=l.map(function(_){return"".concat(u(_)," g_").concat(_,";")}).join(`
`),g=l.map(function(_){return"  g_".concat(_," = v_source_").concat(_,";")}).join(`
`),m=l.map(function(_){return"  g_".concat(_," = v_target_").concat(_,";")}).join(`
`),p=new Set,v=[],y=function(S){p.has(S.name)||(p.add(S.name),v.push("uniform ".concat(S.type," ").concat(S.name,";")))};n.forEach(function(_){return _.uniforms.forEach(y)}),a.forEach(function(_){return _.uniforms.forEach(y)});var b=a.map(function(_){return re(_.widthFactor)}).join(", "),T=Math.max.apply(Math,$(n.map(function(_){return _.minBodyLengthRatio||0}))),x=`#version 300 es

// Node and edge data textures
uniform sampler2D u_nodeDataTexture;
uniform int u_nodeDataTextureWidth;
uniform sampler2D u_edgeDataTexture;
uniform int u_edgeDataTextureWidth;

// Edge attribute texture (for path-specific attributes like curvature)
`.concat(o.uniformDeclarations,`

// Node attribute texture (for node shape attributes)
uniform sampler2D u_layerAttributeTexture;
uniform int u_layerAttributeTextureWidth;
uniform int u_layerAttributeTexelsPerNode;

// Render params needed for clamping
uniform float u_sizeRatio;
uniform float u_correctionRatio;
uniform float u_cameraAngle;
uniform float u_minEdgeThickness;

// Edge-frame texture dimensions, for scattering each point to its texel
uniform float u_frameTextureWidth;
uniform float u_frameTextureHeight;

// Custom path/extremity uniforms
`).concat(v.join(`
`),`

// Path attribute varyings \u2014 assigned so path functions can read them as globals
`).concat(o.vertexVaryingDeclarations,`

// Node size varyings \u2014 read by path functions like loop
out float v_sourceNodeSize;
out float v_targetNodeSize;

// Node shape attributes per endpoint, and the ones querySDF reads
`).concat(d,`
`).concat(f,`

// Scattered output written to the edge-frame texel: [tStart, tEnd, straightenFactor, pathLength]
out vec4 v_clamp;

// Extremity width factor array (needed for extremityScale computation)
const float EXTREMITY_WIDTH_FACTORS[`).concat(a.length,"] = float[](").concat(b,`);

// Node-data fetch helpers (geometry texel + rotation-flags texel)
`).concat(Ne,`
`).concat(Ke,`

// Shape SDFs for node boundary clamping
`).concat(Vl(),`
`).concat(jl(new Set(l)),`

// Path functions
`).concat(_a(n),`
`).concat(Ta(n),`
`).concat(Ou(n),`

void main() {
  // One point per edge-data row; the row index is the edge-frame texel target.
  int edgeIdx = gl_VertexID;
  int texel0Idx = edgeIdx * 2;
  int texel1Idx = edgeIdx * 2 + 1;
  ivec2 edgeTexCoord0 = ivec2(texel0Idx % u_edgeDataTextureWidth, texel0Idx / u_edgeDataTextureWidth);
  ivec2 edgeTexCoord1 = ivec2(texel1Idx % u_edgeDataTextureWidth, texel1Idx / u_edgeDataTextureWidth);
  vec4 edgeData0 = texelFetch(u_edgeDataTexture, edgeTexCoord0, 0);
  vec4 edgeData1 = texelFetch(u_edgeDataTexture, edgeTexCoord1, 0);

  int srcIdx = int(edgeData0.x);
  int tgtIdx = int(edgeData0.y);
  float a_thickness = edgeData0.z;
  float a_headLengthRatio = edgeData1.x;
  float a_tailLengthRatio = edgeData1.y;
  int pathId = int(edgeData1.z);
  int extremityPacked = int(edgeData1.w);
  int headId = extremityPacked >> 4;
  int tailId = extremityPacked & 15;

  // Fetch path/layer attributes and assign to path-function globals
`).concat(o.fetchCode,`
`).concat(o.varyingAssignments,`

  // Fetch node shape attributes for both endpoints
`).concat(h.fetchCode,`
`).concat(h.varyingAssignments,`
`).concat(c.fetchCode,`
`).concat(c.varyingAssignments,`

  // Fetch node geometry (texel 0) and rotation flags (texel 1).
  vec4 srcNodeData = readNodeData(u_nodeDataTexture, u_nodeDataTextureWidth, srcIdx);
  vec4 tgtNodeData = readNodeData(u_nodeDataTexture, u_nodeDataTextureWidth, tgtIdx);

  vec2 a_source = srcNodeData.xy;
  vec2 a_target = tgtNodeData.xy;
  float a_sourceSize = srcNodeData.z;
  float a_targetSize = tgtNodeData.z;
  float a_sourceShapeId = srcNodeData.w;
  float a_targetShapeId = tgtNodeData.w;
  // Per-node rotation alignment (0 = viewport, 1 = graph), for boundary clamping.
  float a_sourceRotateAlign = readNodeFlags(u_nodeDataTexture, u_nodeDataTextureWidth, srcIdx).r;
  float a_targetRotateAlign = readNodeFlags(u_nodeDataTexture, u_nodeDataTextureWidth, tgtIdx).r;

  v_sourceNodeSize = a_sourceSize;
  v_targetNodeSize = a_targetSize;

  float headLengthRatio = a_headLengthRatio;
  float tailLengthRatio = a_tailLengthRatio;
  float headWidthFactor = EXTREMITY_WIDTH_FACTORS[headId];
  float tailWidthFactor = EXTREMITY_WIDTH_FACTORS[tailId];
  float minBodyLengthRatio = `).concat(re(T),`;

  // Thickness in WebGL units (needed to compute clamping margin and extremity lengths)
  float pixelsThickness = max(a_thickness, u_minEdgeThickness * u_sizeRatio);
  float webGLThickness = pixelsThickness * u_correctionRatio / u_sizeRatio;

  // SDF clamping: find where the edge body meets the node boundaries. Always
  // searched (ungated) so labels get a true boundary clamp; the body re-applies
  // its extremity gating in-shader.
`).concat(g,`
  float tStart = queryFindSourceClampT(pathId, a_source, a_sourceSize, int(a_sourceShapeId), a_sourceRotateAlign, a_target, 0.0);
`).concat(m,`
  float tEnd = queryFindTargetClampT(pathId, a_source, a_target, a_targetSize, int(a_targetShapeId), a_targetRotateAlign, 0.0);

  // straightenFactor (frame .z) is consumed only by the body, which runs to the
  // node center when an extremity is absent. Derive the straightening math from
  // these gated clamps \u2014 not the ungated boundary ones above \u2014 so it matches the
  // geometry it drives. The ungated tStart/tEnd remain what labels read.
  float bodyTStart = tailLengthRatio > 0.0 ? tStart : 0.0;
  float bodyTEnd = headLengthRatio > 0.0 ? tEnd : 1.0;

  // Path length and zone boundaries (needed for straightening check)
  float pathLength = queryPathLength(pathId, a_source, a_target);
  float visibleLength = pathLength * (bodyTEnd - bodyTStart);

  float headLength = headLengthRatio * webGLThickness;
  float tailLength = tailLengthRatio * webGLThickness;
  float minBodyLength = minBodyLengthRatio * webGLThickness;

  float totalNeededLength = headLength + tailLength + minBodyLength;
  float extremityScale = 1.0;
  if (totalNeededLength > visibleLength && totalNeededLength > 0.0001) {
    extremityScale = visibleLength / totalNeededLength;
    headLength *= extremityScale;
    tailLength *= extremityScale;
  }

  float headLengthT = pathLength > 0.0001 ? headLength / pathLength : 0.0;
  float tailLengthT = pathLength > 0.0001 ? tailLength / pathLength : 0.0;

  float tTailEnd = bodyTStart + tailLengthT;
  float tHeadStart = bodyTEnd - headLengthT;
  if (tTailEnd > tHeadStart) {
    float mid = (bodyTStart + bodyTEnd) * 0.5;
    tTailEnd = mid;
    tHeadStart = mid;
  }

  // Straighten factor: blend toward straight line when path twists in extremity zones
  float straightenFactor = 0.0;
  {
    float maxDeviation = 0.0;
    if (tailLengthT > 0.0001) {
      vec2 tailTang = queryPathTangent(pathId, tTailEnd, a_source, a_target);
      vec2 tailChord = queryPathPosition(pathId, bodyTStart, a_source, a_target)
                     - queryPathPosition(pathId, tTailEnd, a_source, a_target);
      float tailChordLen = length(tailChord);
      if (tailChordLen > 0.0001) {
        maxDeviation = max(maxDeviation, 1.0 - dot(-tailTang, tailChord / tailChordLen));
      }
    }
    if (headLengthT > 0.0001) {
      vec2 headTang = queryPathTangent(pathId, tHeadStart, a_source, a_target);
      vec2 headChord = queryPathPosition(pathId, bodyTEnd, a_source, a_target)
                     - queryPathPosition(pathId, tHeadStart, a_source, a_target);
      float headChordLen = length(headChord);
      if (headChordLen > 0.0001) {
        maxDeviation = max(maxDeviation, 1.0 - dot(headTang, headChord / headChordLen));
      }
    }
    straightenFactor = smoothstep(0.035, 0.5, maxDeviation);
  }

  // When straightening, blend the ungated tStart/tEnd (the label-facing clamps)
  // toward straight-line clamp positions.
  if (straightenFactor > 0.001) {
    if (tailLengthRatio > 0.0) {
`).concat(g,`
      float srcExtent = a_sourceSize * u_correctionRatio / u_sizeRatio * 2.0;
      float srcEffective = 1.0 - u_correctionRatio / srcExtent;
      float srcCa = u_cameraAngle * (1.0 - a_sourceRotateAlign);
      mat2 srcRot = mat2(cos(srcCa), -sin(srcCa), sin(srcCa), cos(srcCa));
      float lo = 0.0, hi = 0.5;
      for (int i = 0; i < 12; i++) {
        float mid = (lo + hi) * 0.5;
        vec2 pos = mix(a_source, a_target, mid);
        vec2 localPos = srcRot * ((pos - a_source) / srcExtent);
        float sdf = querySDF(int(a_sourceShapeId), localPos, srcEffective);
        if (sdf < 0.0) lo = mid; else hi = mid;
      }
      tStart = mix(tStart, (lo + hi) * 0.5, straightenFactor);
    }
    if (headLengthRatio > 0.0) {
`).concat(m,`
      float tgtExtent = a_targetSize * u_correctionRatio / u_sizeRatio * 2.0;
      float tgtEffective = 1.0 - u_correctionRatio / tgtExtent;
      float tgtCa = u_cameraAngle * (1.0 - a_targetRotateAlign);
      mat2 tgtRot = mat2(cos(tgtCa), -sin(tgtCa), sin(tgtCa), cos(tgtCa));
      float lo = 0.5, hi = 1.0;
      for (int i = 0; i < 12; i++) {
        float mid = (lo + hi) * 0.5;
        vec2 pos = mix(a_source, a_target, mid);
        vec2 localPos = tgtRot * ((pos - a_target) / tgtExtent);
        float sdf = querySDF(int(a_targetShapeId), localPos, tgtEffective);
        if (sdf < 0.0) hi = mid; else lo = mid;
      }
      tEnd = mix(tEnd, (lo + hi) * 0.5, straightenFactor);
    }
  }

  v_clamp = vec4(tStart, tEnd, straightenFactor, pathLength);

  // Scatter this point to its edge's texel center in the frame texture.
  float x = mod(float(edgeIdx), u_frameTextureWidth);
  float y = floor(float(edgeIdx) / u_frameTextureWidth);
  vec2 ndc = (vec2(x, y) + 0.5) / vec2(u_frameTextureWidth, u_frameTextureHeight) * 2.0 - 1.0;
  gl_Position = vec4(ndc, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`);return x}var An=0,Jr=1,wn=2;function $u(n,a,t){var e=[];t&&(e.push([An,0,-1],[An,0,1]),e.push([An,1,-1],[An,1,1]));for(var r=0;r<=n;r++){var i=r/n;e.push([Jr,i,-1],[Jr,i,1])}return a&&(e.push([wn,0,-1],[wn,0,1]),e.push([wn,1,-1],[wn,1,1])),{data:e,attributes:[{name:"a_zone",size:1,type:Wt},{name:"a_zoneT",size:1,type:Wt},{name:"a_side",size:1,type:Wt}],verticesPerEdge:e.length}}function Vu(n,a,t,e){var r=Te([].concat($(n),$(t))),i=Ht(r),o=new Set(["u_matrix","u_sizeRatio","u_correctionRatio","u_zoomRatio","u_pixelRatio","u_cameraAngle","u_minEdgeThickness","u_pickingPadding","u_nodeDataTexture"]),s=new Set,l=[],u=function(v){!o.has(v.name)&&!s.has(v.name)&&(s.add(v.name),l.push("uniform ".concat(v.type," ").concat(v.name,";")))};n.forEach(function(p){return p.uniforms.forEach(u)}),a.forEach(function(p){return p.uniforms.forEach(u)}),t.forEach(function(p){return p.uniforms.forEach(u)});var d=e.map(function(p){var v=p.size===1?"float":"vec".concat(p.size);return"in ".concat(v," ").concat(p.name,";")}).join(`
`),h=a.map(function(p){return re(p.widthFactor)}).join(", "),c=Math.max.apply(Math,$(n.map(function(p){return p.minBodyLengthRatio||0}))),f=t.some(function(p){return p.needsNodeColors}),g=n.some(function(p){return p.needsNodeSize}),m=`#version 300 es

// Constant attributes (per vertex)
`.concat(d,`

// Per-edge attributes
// Edge data (source/target indices, thickness, extremity ratios, path/extremity IDs)
// is fetched from edge data texture via edge index
in float a_edgeIndex;   // Index into edge data texture
in vec4 a_color;        // Edge color
in vec4 a_id;           // Edge ID for picking
in float a_opacity;     // Edge opacity

// Standard uniforms
uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_correctionRatio;
uniform float u_zoomRatio;
uniform float u_pixelRatio;
uniform float u_cameraAngle;
uniform float u_minEdgeThickness;
#ifdef PICKING_MODE
uniform float u_pickingPadding;
#endif
uniform sampler2D u_nodeDataTexture;
uniform int u_nodeDataTextureWidth;
uniform sampler2D u_edgeDataTexture;
uniform int u_edgeDataTextureWidth;
uniform sampler2D u_edgeFrameTexture;
uniform int u_edgeFrameTextureWidth;

// Edge path attribute texture uniforms
`).concat(i.uniformDeclarations,`

// Custom uniforms
`).concat(l.join(`
`),`

// Standard varyings
out vec4 v_color;
out float v_opacity;
out vec4 v_id;
out float v_thickness;       // Edge body thickness (in consistent units)
out float v_t;
out float v_tStart;
out float v_tEnd;
out float v_side;
out float v_antialiasingWidth;  // Anti-aliasing width (normalized: u_correctionRatio / thickness)
out vec2 v_source;
out vec2 v_target;
out float v_edgeLength;
`).concat(g?`
out float v_sourceNodeSize;  // Source node size (mirrored in labels/generator.ts as plain float)
out float v_targetNodeSize;  // Target node size (mirrored in labels/generator.ts as plain float)`:"",`
`).concat(f?`
out vec4 v_sourceColor;
out vec4 v_targetColor;`:"",`
// Zone varyings
out float v_zone;            // 0=tail, 1=body, 2=head
out float v_zoneT;           // Position within zone [0,1]
out float v_headLengthRatio; // Head length as ratio of thickness
out float v_tailLengthRatio; // Tail length as ratio of thickness
out float v_headWidthRatio;  // Head width factor
out float v_tailWidthRatio;  // Tail width factor

// Multi-path/extremity varyings
flat out int v_pathId;
flat out int v_headId;
flat out int v_tailId;

// Path/layer attribute varyings (fetched from edge attribute texture)
`).concat(i.vertexVaryingDeclarations,`

const float bias = 255.0 / 254.0;

// Width factor array for extremities (shared pool for head/tail)
const float EXTREMITY_WIDTH_FACTORS[`).concat(a.length,"] = float[](").concat(h,`);

// All path functions
`).concat(_a(n),`

// Path selector functions
`).concat(Ta(n),`

// Node-data fetch helper (geometry texel of the two-texel node stride)
`).concat(Ne,`
`).concat(f?Jl:"",`
// Per-edge clamp from the frame-pass (tStart, tEnd, straightenFactor, pathLength)
`).concat(yt,`

void main() {
  // Fetch edge data from edge texture (2 texels per edge)
  // Texel 0: sourceNodeIndex, targetNodeIndex, thickness, reserved
  // Texel 1: headLengthRatio, tailLengthRatio, pathId, (headId << 4) | tailId
  int edgeIdx = int(a_edgeIndex);

  // Hidden edges are flagged with a negative row by EdgeProgram.process(). Push
  // the whole primitive outside the clip volume: every vertex lands at the same
  // out-of-range position, so it is fully clipped and rasterizes nothing \u2014
  // neither to the frame buffer nor to the picking buffer.
  if (edgeIdx < 0) {
    gl_Position = vec4(2.0, 0.0, 0.0, 1.0);
    v_color = vec4(0.0);
    v_id = vec4(0.0);
    return;
  }

  int texel0Idx = edgeIdx * 2;
  int texel1Idx = edgeIdx * 2 + 1;
  ivec2 edgeTexCoord0 = ivec2(texel0Idx % u_edgeDataTextureWidth, texel0Idx / u_edgeDataTextureWidth);
  ivec2 edgeTexCoord1 = ivec2(texel1Idx % u_edgeDataTextureWidth, texel1Idx / u_edgeDataTextureWidth);
  vec4 edgeData0 = texelFetch(u_edgeDataTexture, edgeTexCoord0, 0);
  vec4 edgeData1 = texelFetch(u_edgeDataTexture, edgeTexCoord1, 0);

  // Unpack edge data
  int srcIdx = int(edgeData0.x);
  int tgtIdx = int(edgeData0.y);
  float a_thickness = edgeData0.z;
  // edgeData0.w is now reserved (curvature moved to path attribute texture)
  float a_headLengthRatio = edgeData1.x;
  float a_tailLengthRatio = edgeData1.y;
  int pathId = int(edgeData1.z);
  int extremityPacked = int(edgeData1.w);
  int headId = extremityPacked >> 4;
  int tailId = extremityPacked & 15;

  // Fetch path/layer attributes from edge attribute texture
`).concat(i.fetchCode,`

  // Assign path/layer attribute varyings
`).concat(i.varyingAssignments,`

  // Fetch source and target node geometry (texel 0 of the two-texel node stride)
  vec4 srcNodeData = readNodeData(u_nodeDataTexture, u_nodeDataTextureWidth, srcIdx);
  vec4 tgtNodeData = readNodeData(u_nodeDataTexture, u_nodeDataTextureWidth, tgtIdx);

  vec2 a_source = srcNodeData.xy;
  vec2 a_target = tgtNodeData.xy;
`).concat(g?`
  // Assign node size varyings early (path functions like loops need them during clamping)
  v_sourceNodeSize = srcNodeData.z;
  v_targetNodeSize = tgtNodeData.z;`:"",`
`).concat(f?`
  v_sourceColor = readNodeColor(u_nodeDataTexture, u_nodeDataTextureWidth, srcIdx);
  v_targetColor = readNodeColor(u_nodeDataTexture, u_nodeDataTextureWidth, tgtIdx);`:"",`

  // Convert thickness to WebGL units
  float minThickness = u_minEdgeThickness;
  float pixelsThickness = max(a_thickness, minThickness * u_sizeRatio);
  float webGLThickness = pixelsThickness * u_correctionRatio / u_sizeRatio;

  // Extremity parameters from ID lookups (shared pool)
  float headLengthRatio = a_headLengthRatio;
  float tailLengthRatio = a_tailLengthRatio;
  float headWidthFactor = EXTREMITY_WIDTH_FACTORS[headId];
  float tailWidthFactor = EXTREMITY_WIDTH_FACTORS[tailId];
  float minBodyLengthRatio = `).concat(re(c),`;

  // Per-edge values from the frame-pass texture (read by edge index).
  // tStart/tEnd are the ungated boundary clamps: re-apply the body's extremity
  // gating here (no extremity \u2192 body runs to the node center, 0/1).
  vec4 frameClamp = readFrameTexel(u_edgeFrameTexture, u_edgeFrameTextureWidth, edgeIdx);
  float tStart           = a_tailLengthRatio > 0.0 ? frameClamp.x : 0.0;
  float tEnd             = a_headLengthRatio > 0.0 ? frameClamp.y : 1.0;
  float straightenFactor = frameClamp.z;
  float pathLength       = frameClamp.w;

  // Anti-aliasing width (~1 pixel, normalized by thickness)
  float antialiasingWidth = u_correctionRatio / webGLThickness;

  float visibleLength = pathLength * (tEnd - tStart);

  // Compute extremity lengths in world units
  float headLength = headLengthRatio * webGLThickness;
  float tailLength = tailLengthRatio * webGLThickness;
  float minBodyLength = minBodyLengthRatio * webGLThickness;

  // Handle short edges: scale down extremities if needed
  float totalNeededLength = headLength + tailLength + minBodyLength;
  float extremityScale = 1.0;
  if (totalNeededLength > visibleLength && totalNeededLength > 0.0001) {
    extremityScale = visibleLength / totalNeededLength;
    headLength *= extremityScale;
    tailLength *= extremityScale;
  }

  // Convert lengths to t-values
  float headLengthT = pathLength > 0.0001 ? headLength / pathLength : 0.0;
  float tailLengthT = pathLength > 0.0001 ? tailLength / pathLength : 0.0;

  // Zone boundaries in t-space
  float tTailEnd = tStart + tailLengthT;
  float tHeadStart = tEnd - headLengthT;

  // Ensure body has non-negative length
  if (tTailEnd > tHeadStart) {
    float mid = (tStart + tEnd) * 0.5;
    tTailEnd = mid;
    tHeadStart = mid;
  }

  // Convert to webGL units for geometry expansion
  float aaWidthWebGL = antialiasingWidth * webGLThickness;

  // Extra geometry width for picking padding (0 in visual mode)
  #ifdef PICKING_MODE
    float pickingPaddingWebGL = u_pickingPadding * u_correctionRatio;
  #else
    float pickingPaddingWebGL = 0.0;
  #endif

  // Straight-line direction and normal (for blending when straightenFactor > 0)
  vec2 straightDir = length(a_target - a_source) > 0.0001
    ? normalize(a_target - a_source) : vec2(1.0, 0.0);
  vec2 straightNormal = vec2(-straightDir.y, straightDir.x);

  // Zone-based vertex processing using path selectors
  vec2 position;
  vec2 normal;
  float t;
  float zone = a_zone;
  float zoneT = a_zoneT;
  float side = a_side;

  // Scaled extremity width factors (geometry must be at least as wide as body)
  float scaledTailWidth = max(tailWidthFactor * extremityScale, 1.0);
  float scaledHeadWidth = max(headWidthFactor * extremityScale, 1.0);

  if (zone < 0.5) {
    // TAIL ZONE: rectangular quad with scaled width
    vec2 tang = queryPathTangent(pathId, tTailEnd, a_source, a_target);
    normal = vec2(-tang.y, tang.x);
    vec2 centerPos = mix(queryPathPosition(pathId, tStart, a_source, a_target),
                         queryPathPosition(pathId, tTailEnd, a_source, a_target), zoneT);
    float halfWidth = webGLThickness * scaledTailWidth * 0.5 + aaWidthWebGL + pickingPaddingWebGL;
    position = centerPos + normal * side * halfWidth;
    t = mix(tStart, tTailEnd, zoneT);

  } else if (zone < 1.5) {
    // BODY ZONE: follows path curvature with width = 1.0
    t = mix(tTailEnd, tHeadStart, zoneT);
    normal = queryPathNormal(pathId, t, a_source, a_target);
    float halfWidth = webGLThickness * 0.5 + aaWidthWebGL + pickingPaddingWebGL;
    position = queryPathPosition(pathId, t, a_source, a_target) + normal * side * halfWidth;

  } else {
    // HEAD ZONE: rectangular quad with scaled width
    vec2 tang = queryPathTangent(pathId, tHeadStart, a_source, a_target);
    normal = vec2(-tang.y, tang.x);
    vec2 centerPos = mix(queryPathPosition(pathId, tHeadStart, a_source, a_target),
                         queryPathPosition(pathId, tEnd, a_source, a_target), zoneT);
    float halfWidth = webGLThickness * scaledHeadWidth * 0.5 + aaWidthWebGL + pickingPaddingWebGL;
    position = centerPos + normal * side * halfWidth;
    t = mix(tHeadStart, tEnd, zoneT);
  }

  // Blend toward straight line based on path twist in extremity zones
  if (straightenFactor > 0.001) {
    float zoneWidth = zone < 0.5 ? webGLThickness * scaledTailWidth * 0.5 + aaWidthWebGL + pickingPaddingWebGL :
                      zone < 1.5 ? webGLThickness * 0.5 + aaWidthWebGL + pickingPaddingWebGL :
                      webGLThickness * scaledHeadWidth * 0.5 + aaWidthWebGL + pickingPaddingWebGL;
    vec2 straightPos = mix(a_source, a_target, t) + straightNormal * side * zoneWidth;
    position = mix(position, straightPos, straightenFactor);
  }

  gl_Position = vec4((u_matrix * vec3(position, 1.0)).xy, 0.0, 1.0);

  // Pass varyings to fragment shader
  v_color = a_color;
  v_color.a *= bias;
  v_opacity = a_opacity;
  v_id = a_id;
  v_thickness = webGLThickness;
  v_t = t;
  v_tStart = tStart;
  v_tEnd = tEnd;
  v_side = side;
  v_antialiasingWidth = antialiasingWidth;
  v_source = a_source;
  v_target = a_target;
  v_edgeLength = pathLength;

  // Zone varyings
  v_zone = zone;
  v_zoneT = zoneT;
  v_headLengthRatio = headLengthRatio * extremityScale;
  v_tailLengthRatio = tailLengthRatio * extremityScale;
  // Scale extremity width proportionally with length when crushed
  v_headWidthRatio = headWidthFactor * extremityScale;
  v_tailWidthRatio = tailWidthFactor * extremityScale;

  // Multi-path varyings
  v_pathId = pathId;
  v_headId = headId;
  v_tailId = tailId;
}
`);return m}function ju(n,a,t,e){var r=Te([].concat($(n),$(t))),i=Ht(r),o=new Set(["u_matrix","u_sizeRatio","u_correctionRatio","u_zoomRatio","u_pixelRatio","u_cameraAngle","u_minEdgeThickness","u_pickingPadding"]),s=new Set,l=[],u=function(y){!o.has(y.name)&&!s.has(y.name)&&(s.add(y.name),l.push("uniform ".concat(y.type," ").concat(y.name,";")))};n.forEach(function(v){return v.uniforms.forEach(u)}),a.forEach(function(v){return v.uniforms.forEach(u)}),t.forEach(function(v){return v.uniforms.forEach(u)});var d=a.map(function(v){var y;return re((y=v.baseRatio)!==null&&y!==void 0?y:.5)}).join(", "),h=function(y){var b,T;return a.length>1?"EXTREMITY_BASE_RATIOS[".concat(y,"]"):re((b=(T=a[0])===null||T===void 0?void 0:T.baseRatio)!==null&&b!==void 0?b:.5)},c=a.some(function(v){return Fe(v.length)?!0:v.length>0}),f=t.some(function(v){return v.needsNodeColors}),g=n.some(function(v){return v.needsNodeSize}),m=t.map(function(v,y){return"  // Layer ".concat(y+1,": ").concat(v.name,`
  color = blendOver(color, layer_`).concat(v.name,"(context));")}).join(`

`),p=`#version 300 es
precision highp float;

// Standard varyings
in vec4 v_color;
in float v_opacity;
in vec4 v_id;
in float v_thickness;       // Edge body thickness
in float v_t;
in float v_tStart;
in float v_tEnd;
in float v_side;
in float v_antialiasingWidth;  // Anti-aliasing width (normalized: u_correctionRatio / thickness)
in vec2 v_source;
in vec2 v_target;
in float v_edgeLength;
`.concat(g?`
in float v_sourceNodeSize;   // Source node size (mirrored in labels/generator.ts as plain float)
in float v_targetNodeSize;   // Target node size (mirrored in labels/generator.ts as plain float)`:"",`
`).concat(f?`
in vec4 v_sourceColor;
in vec4 v_targetColor;`:"",`
// Zone varyings
in float v_zone;            // 0=tail, 1=body, 2=head
in float v_zoneT;           // Position within zone [0,1]
in float v_headLengthRatio; // Head length as ratio of thickness (scaled for short edges)
in float v_tailLengthRatio; // Tail length as ratio of thickness (scaled for short edges)
in float v_headWidthRatio;  // Head width factor
in float v_tailWidthRatio;  // Tail width factor

// Multi-path/extremity varyings
flat in int v_pathId;
flat in int v_headId;
flat in int v_tailId;

// Path/layer attribute varyings (from vertex shader texture fetch)
`).concat(i.fragmentVaryingDeclarations,`

// Standard uniforms (needed by some path types)
uniform float u_sizeRatio;
uniform float u_correctionRatio;
uniform float u_cameraAngle;
#ifdef PICKING_MODE
uniform float u_pickingPadding;
#endif

// Custom uniforms
`).concat(l.join(`
`),`

// Fragment output (single target - picking handled via separate pass)
out vec4 fragColor;

`).concat(a.length>1?`// Base ratio array for extremities (shared pool for head/tail)
const float EXTREMITY_BASE_RATIOS[`.concat(a.length,"] = float[](").concat(d,");"):"",`

// EdgeContext struct
struct EdgeContext {
  float t;                   // Position along path [0, 1]
  float sdf;                 // Signed distance from centerline
  vec2 position;             // World position
  vec2 tangent;              // Path tangent
  vec2 normal;               // Path normal
  float thickness;           // Edge thickness
  float aaWidth;             // Anti-aliasing width
  float edgeLength;          // Total path length
  float tStart;              // Clamped start t
  float tEnd;                // Clamped end t
  float distanceFromSource;  // Arc distance from source
  float distanceToTarget;    // Arc distance to target
};

EdgeContext context;

// Alpha "over" compositing for layer blending
vec4 blendOver(vec4 bg, vec4 fg) {
  float a = fg.a;
  return vec4(mix(bg.rgb, fg.rgb, a), bg.a + a * (1.0 - bg.a));
}

// All path functions
`).concat(_a(n),`

// Path selector functions
`).concat(Ta(n),`

// All extremity functions
`).concat(zu(a),`

// Extremity SDF selector (shared pool for head/tail)
`).concat(Uu(a),`

// Layer functions
`).concat(t.map(function(v){return v.glsl}).join(`

`),`

// Helper: Compute arc length using path selector
float computeArcLengthMulti(int pathId, float t0, float t1, vec2 source, vec2 target, int samples) {
  float arcLen = 0.0;
  vec2 prev = queryPathPosition(pathId, t0, source, target);
  for (int i = 1; i <= samples; i++) {
    float t = t0 + (t1 - t0) * float(i) / float(samples);
    vec2 curr = queryPathPosition(pathId, t, source, target);
    arcLen += length(curr - prev);
    prev = curr;
  }
  return arcLen;
}

void main() {
  // Compute normalized t within visible edge (0 = start, 1 = end)
  float tNorm = (v_t - v_tStart) / max(v_tEnd - v_tStart, 0.0001);

  // Edge body half-thickness
  float halfThickness = v_thickness * 0.5;

  // Convert normalized AA width to webGL units (~1 pixel)
  float aaWidthWebGL = v_antialiasingWidth * v_thickness;

  // Distance from centerline based on v_side interpolation
  float zoneWidthFactor = v_zone < 0.5 ? v_tailWidthRatio :
                          v_zone < 1.5 ? 1.0 :
                          v_headWidthRatio;
  // In PICKING_MODE, inflate halfGeometryWidth to match the inflated vertex geometry
  #ifdef PICKING_MODE
    float halfGeometryWidth = halfThickness * zoneWidthFactor + aaWidthWebGL + u_pickingPadding * aaWidthWebGL;
  #else
    float halfGeometryWidth = halfThickness * zoneWidthFactor + aaWidthWebGL;
  #endif
  float distFromCenter = abs(v_side) * halfGeometryWidth;

  // Populate EdgeContext (for layer functions)
  context.t = tNorm;
  context.sdf = distFromCenter - halfThickness;
  context.position = queryPathPosition(v_pathId, v_t, v_source, v_target);
  context.tangent = queryPathTangent(v_pathId, v_t, v_source, v_target);
  context.normal = vec2(-context.tangent.y, context.tangent.x);
  context.thickness = v_thickness;
  context.aaWidth = aaWidthWebGL;
  context.edgeLength = v_edgeLength;
  context.tStart = v_tStart;
  context.tEnd = v_tEnd;

  // Compute arc distances
  float visibleLength = v_edgeLength * (v_tEnd - v_tStart);
  float pathT = v_t;
  float pathTNorm = tNorm;
`).concat(n.every(function(v){return v.linearParameterization})?`  // All paths have linear parameterization: t maps directly to arc distance
  context.distanceFromSource = pathTNorm * visibleLength;
  context.distanceToTarget = (1.0 - pathTNorm) * visibleLength;`:n.every(function(v){return!v.linearParameterization})?`  // No paths have linear parameterization: use numerical integration
  context.distanceFromSource = computeArcLengthMulti(v_pathId, v_tStart, pathT, v_source, v_target, 16);
  context.distanceToTarget = computeArcLengthMulti(v_pathId, pathT, v_tEnd, v_source, v_target, 16);`:`  // Mixed parameterization: use analytical for linear paths, numerical for others
  if (`.concat(n.filter(function(v){return v.linearParameterization}).map(function(v){return"v_pathId == ".concat(n.indexOf(v))}).join(" || "),`) {
    context.distanceFromSource = pathTNorm * visibleLength;
    context.distanceToTarget = (1.0 - pathTNorm) * visibleLength;
  } else {
    context.distanceFromSource = computeArcLengthMulti(v_pathId, v_tStart, pathT, v_source, v_target, 16);
    context.distanceToTarget = computeArcLengthMulti(v_pathId, pathT, v_tEnd, v_source, v_target, 16);
  }`),`

  // Compute SDF based on zone using extremity selector (shared pool)
  float bodySDF = distFromCenter - halfThickness;
  float finalSDF;

`).concat(c?`  // Base ratios, from baseRatioLookup
  float headBaseRatio = `.concat(h("v_headId"),`;
  float tailBaseRatio = `).concat(h("v_tailId"),`;

  if (v_zone < 0.5) {
    // TAIL ZONE: v_zoneT goes 0 (tip) to 1 (base)
    vec2 uv = vec2((1.0 - v_zoneT) * v_tailLengthRatio, v_side * v_tailWidthRatio * 0.5);
    float tailSDF = queryExtremitySDF(v_tailId, uv, v_tailLengthRatio, v_tailWidthRatio) * v_thickness;

    // Apply union only near base (v_zoneT > 1 - baseRatio)
    if (v_zoneT > 1.0 - tailBaseRatio) {
      finalSDF = min(tailSDF, bodySDF);
    } else {
      finalSDF = tailSDF;
    }
  } else if (v_zone < 1.5) {
    // BODY ZONE: distance from centerline
    finalSDF = bodySDF;
  } else {
    // HEAD ZONE: v_zoneT goes 0 (base) to 1 (tip)
    vec2 uv = vec2(v_zoneT * v_headLengthRatio, v_side * v_headWidthRatio * 0.5);
    float headSDF = queryExtremitySDF(v_headId, uv, v_headLengthRatio, v_headWidthRatio) * v_thickness;

    // Apply union only near base (v_zoneT < baseRatio)
    if (v_zoneT < headBaseRatio) {
      finalSDF = min(headSDF, bodySDF);
    } else {
      finalSDF = headSDF;
    }
  }`):`  // No extremity draws tail/head geometry, so every vertex is body zone.
  finalSDF = bodySDF;`,`

  #ifdef PICKING_MODE
    // Picking pass: output edge ID for pixels within the picking area
    if (finalSDF > u_pickingPadding * aaWidthWebGL) discard;
    fragColor = v_id;
  #else
`).concat(e?`    // Visual pass: anti-aliased edge with layers, edge opacity applied once
    float alpha = smoothstep(aaWidthWebGL, -aaWidthWebGL, finalSDF) * v_opacity;`:`    // Visual pass: hard-edged (no anti-aliasing gradient) edge with layers, edge opacity applied once
    float alpha = (finalSDF < 0.0 ? 1.0 : 0.0) * v_opacity;`,`
    if (alpha < 0.01) discard;

    // Apply layers sequentially with "over" compositing
    vec4 color = vec4(0.0);

`).concat(m,`

    // Mix with transparent to fade both color AND alpha (pre-multiplied alpha for correct blending)
    fragColor = mix(vec4(0.0), color, alpha);
  #endif
}
`);return p}function Xu(n,a,t){var e=Fe(a.length)?!0:a.length>0,r=Fe(t.length)?!0:t.length>0;if(n.generateConstantData){var i=n.generateConstantData();return{data:i.data,attributes:i.attributes,verticesPerEdge:i.verticesPerEdge}}return $u(n.segments,e,r)}function ei(n){var a,t=yi(n),e=t.paths,r=t.extremities,i=t.layers,o=(a=n.antialias)!==null&&a!==void 0?a:!0,s=new Map,l=new Map,u=new Map,d=z(e),h;try{for(d.s();!(h=d.n()).done;){var c=h.value,f=z(r),g;try{for(f.s();!(g=f.n()).done;){var m=g.value,p=z(r),v;try{for(p.s();!(v=p.n()).done;){var y=v.value,b="".concat(c.name,":").concat(m.name,":").concat(y.name),T=Xu(c,m,y);s.set(b,T.verticesPerEdge),l.set(b,T.data);var x=z(T.attributes),_;try{for(x.s();!(_=x.n()).done;){var S=_.value;u.has(S.name)||u.set(S.name,S)}}catch(j){x.e(j)}finally{x.f()}}}catch(j){p.e(j)}finally{p.f()}}}catch(j){f.e(j)}finally{f.f()}}}catch(j){d.e(j)}finally{d.f()}var A=Array.from(u.values()),R={};A.forEach(function(j,X){R[j.name]=X});var w=0,F="",D=z(s),I;try{for(D.s();!(I=D.n()).done;){var C=Q(I.value,2),k=C[0],G=C[1];G>w&&(w=G,F=k)}}catch(j){D.e(j)}finally{D.f()}var N=l.get(F)||[],L=F.split(":"),P=Q(L,1),M=P[0],H=e.find(function(j){return j.name===M}),O=[];H!=null&&H.generateConstantData?O=H.generateConstantData().attributes:O=[{name:"a_zone"},{name:"a_zoneT"},{name:"a_side"}];var q=N.map(function(j){var X=new Array(A.length).fill(0);return O.forEach(function(Ee,he){var Le=R[Ee.name];Le!==void 0&&he<j.length&&(X[Le]=j[he])}),X});return{vertexShader:Vu(e,r,i,A),fragmentShader:ju(e,r,i,o),uniforms:Mu(e,r,i),attributes:qu(),verticesPerEdge:w,constantData:q,constantAttributes:A,vertexCountsPerCombination:s,constantDataPerCombination:l}}function qu(n,a,t){return[{name:"a_edgeIndex",size:1,type:Wt},{name:"a_color",size:4,type:Qr,normalized:!0},{name:"a_id",size:4,type:Qr,normalized:!0},{name:"a_opacity",size:1,type:Wt}]}var Yu=`#version 300 es
precision highp float;

in vec4 v_clamp;

// RGBA32F target: stores (tStart, tEnd, straightenFactor, pathLength).
out vec4 fragColor;

void main() {
  fragColor = v_clamp;
}
`,Ku=function(){function n(a,t){Y(this,n),E(this,"uniformLocations",{});var e=t.paths,r=t.extremities,i=t.layers,o=t.nodeShapes,s=t.nodeLayers;this.gl=a,this.hasAttributeData=Te([].concat($(e),$(i))).floatsPerItem>0,this.hasNodeAttributeData=Object.keys(bt(o,s).offsets).length>0,this.vertexShader=ga(a,Hu(e,r,i,o,s)),this.fragmentShader=va(a,Yu),this.program=pa(a,[this.vertexShader,this.fragmentShader]);var l=new Set;this.customUniforms=[];for(var u=0,d=[].concat($(e),$(r));u<d.length;u++){var h=d[u],c=z(h.uniforms),f;try{for(c.s();!(f=c.n()).done;){var g=f.value;l.has(g.name)||(l.add(g.name),this.customUniforms.push(g))}}catch(b){c.e(b)}finally{c.f()}}var m=["u_sizeRatio","u_correctionRatio","u_cameraAngle","u_minEdgeThickness","u_nodeDataTexture","u_nodeDataTextureWidth","u_edgeDataTexture","u_edgeDataTextureWidth","u_edgeAttributeTexture","u_edgeAttributeTextureWidth","u_edgeAttributeTexelsPerEdge","u_layerAttributeTexture","u_layerAttributeTextureWidth","u_layerAttributeTexelsPerNode","u_frameTextureWidth","u_frameTextureHeight"].concat($(this.customUniforms.map(function(b){return b.name}))),p=z(m),v;try{for(p.s();!(v=p.n()).done;){var y=v.value;this.uniformLocations[y]=a.getUniformLocation(this.program,y)}}catch(b){p.e(b)}finally{p.f()}this.vao=a.createVertexArray()}return K(n,[{key:"run",value:function(t,e,r,i,o){if(r!==0){var s=this.gl,l=this.uniformLocations;s.useProgram(this.program),s.bindVertexArray(this.vao),l.u_sizeRatio&&s.uniform1f(l.u_sizeRatio,t.sizeRatio),l.u_correctionRatio&&s.uniform1f(l.u_correctionRatio,t.correctionRatio),l.u_cameraAngle&&s.uniform1f(l.u_cameraAngle,t.cameraAngle),l.u_minEdgeThickness&&s.uniform1f(l.u_minEdgeThickness,t.minEdgeThickness),l.u_nodeDataTexture&&s.uniform1i(l.u_nodeDataTexture,t.nodeDataTextureUnit),l.u_nodeDataTextureWidth&&s.uniform1i(l.u_nodeDataTextureWidth,t.nodeDataTextureWidth),l.u_edgeDataTexture&&s.uniform1i(l.u_edgeDataTexture,t.edgeDataTextureUnit),l.u_edgeDataTextureWidth&&s.uniform1i(l.u_edgeDataTextureWidth,t.edgeDataTextureWidth),l.u_frameTextureWidth&&s.uniform1f(l.u_frameTextureWidth,e.getTextureWidth()),l.u_frameTextureHeight&&s.uniform1f(l.u_frameTextureHeight,e.getTextureHeight()),this.hasAttributeData&&i&&(i.bind(Ue),l.u_edgeAttributeTexture&&s.uniform1i(l.u_edgeAttributeTexture,Ue),l.u_edgeAttributeTextureWidth&&s.uniform1i(l.u_edgeAttributeTextureWidth,i.getTextureWidth()),l.u_edgeAttributeTexelsPerEdge&&s.uniform1i(l.u_edgeAttributeTexelsPerEdge,i.getTexelsPerItem())),this.hasNodeAttributeData&&o&&(o.bind(Be),l.u_layerAttributeTexture&&s.uniform1i(l.u_layerAttributeTexture,Be),l.u_layerAttributeTextureWidth&&s.uniform1i(l.u_layerAttributeTextureWidth,o.getTextureWidth()),l.u_layerAttributeTexelsPerNode&&s.uniform1i(l.u_layerAttributeTexelsPerNode,o.getTexelsPerItem()));var u=z(this.customUniforms),d;try{for(u.s();!(d=u.n()).done;){var h=d.value;xa(s,this.uniformLocations[h.name],h)}}catch(c){u.e(c)}finally{u.f()}e.bindAsRenderTarget(),s.disable(s.BLEND),s.disable(s.DEPTH_TEST),s.drawArrays(s.POINTS,0,r),s.bindFramebuffer(s.FRAMEBUFFER,null),s.bindVertexArray(null)}}},{key:"kill",value:function(){var t=this.gl;t.deleteProgram(this.program),t.deleteShader(this.vertexShader),t.deleteShader(this.fragmentShader),t.deleteVertexArray(this.vao)}}])}();function Mt(n,a,t,e,r,i){if(n.length===1)return"".concat(e," ").concat(a,"(int pathId, ").concat(r,`) {
  return path_`).concat(n[0].name,"_").concat(t,"(").concat(i,`);
}`);var o=n.map(function(s,l){return"    case ".concat(l,": return path_").concat(s.name,"_").concat(t,"(").concat(i,");")}).join(`
`);return"".concat(e," ").concat(a,"(int pathId, ").concat(r,`) {
  switch (pathId) {
`).concat(o,`
    default: return path_`).concat(n[0].name,"_").concat(t,"(").concat(i,`);
  }
}`)}var Zu=`
vec3 computeEdgeLabelBodyBounds(
  float tStart, float tEnd, float pathLength,
  float webGLThickness, float headLengthRatio, float tailLengthRatio
) {
  float visibleLength = pathLength * (tEnd - tStart);

  float headLength = headLengthRatio * webGLThickness;
  float tailLength = tailLengthRatio * webGLThickness;
  float totalNeededLength = headLength + tailLength;
  if (totalNeededLength > visibleLength && totalNeededLength > 0.0001) {
    float extremityScale = visibleLength / totalNeededLength;
    headLength *= extremityScale;
    tailLength *= extremityScale;
  }

  float bodyStartDist = tStart * pathLength + tailLength;
  float bodyEndDist = tEnd * pathLength - headLength;
  return vec3(bodyStartDist, bodyEndDist, max(bodyEndDist - bodyStartDist, 0.0));
}
`;function Qu(n,a){var t=re(n),e=re(a);return`
float computeEdgeLabelAlpha(float bodyLength, float textWidthWebGL) {
  float ratio = textWidthWebGL > 0.0001 ? min(bodyLength / textWidthWebGL, 1.0) : 1.0;
  if (ratio < `.concat(t,`) return 0.0;
  if (ratio < `).concat(e,") return (ratio - ").concat(t,") / (").concat(e," - ").concat(t,`);
  return 1.0;
}
`)}var Ju=`
float computeEdgeLabelScreenDir(int pathId, float t, vec2 source, vec2 target, mat3 matrix) {
  vec2 tangent = queryPathTangent(pathId, t, source, target);
  return (matrix * vec3(tangent, 0.0)).x < 0.0 ? -1.0 : 1.0;
}
`,ed=`
float computeEdgeLabelPerpOffset(
  float positionMode,
  float halfThickness, float marginWebGL, float halfTextHeight,
  float readingSign, float screenDir
) {
  float magnitude = halfThickness + marginWebGL + halfTextHeight;
  if (positionMode == 1.0) return magnitude * readingSign;
  if (positionMode == 2.0) return -magnitude * readingSign;
  if (positionMode == 3.0) return magnitude * screenDir;
  return 0.0;
}
`;function xi(n){var a=n.paths,t=n.minVisibilityThreshold,e=n.fullVisibilityThreshold,r=a.some(function(s){return s.hasSharpCorners}),i=a.map(function(s){return"// --- Path: ".concat(s.name,` ---
`).concat(s.glsl,`

// Tangent/normal functions: analytical if provided, otherwise numerical
`).concat(s.analyticalTangentGlsl||pi(s.name),`

// Auto-generated fallbacks for any missing path functions
`).concat(mi(s.name,s.glsl),`

// Corner skip helpers (for paths with sharp corners like step/taxi)
`).concat(s.cornerSkipGlsl||"",`
`)}).join(`
`),o=r?`// Corner function selectors (only some paths have sharp corners)
vec2 queryGetCornerTs(int pathId, vec2 source, vec2 target) {
  switch (pathId) {
`.concat(a.map(function(s,l){return s.hasSharpCorners?"    case ".concat(l,": return path_").concat(s.name,"_getCornerTs(source, target);"):"    case ".concat(l,": return vec2(-1.0, -1.0); // No corners for ").concat(s.name)}).join(`
`),`
    default: return vec2(-1.0, -1.0);
  }
}

vec2 queryGetCornerConcavity(int pathId, vec2 source, vec2 target, float perpOffset) {
  switch (pathId) {
`).concat(a.map(function(s,l){return s.hasSharpCorners?"    case ".concat(l,": return path_").concat(s.name,"_getCornerConcavity(source, target, perpOffset);"):"    case ".concat(l,": return vec2(0.0, 0.0); // No corners for ").concat(s.name)}).join(`
`),`
    default: return vec2(0.0, 0.0);
  }
}`):"";return`
// ============================================================================
// Node data fetch (geometry texel) and per-edge clamp fetch (edge-frame texture)
// ============================================================================

`.concat(Ne,`
`).concat(yt,`

// ============================================================================
// Path Functions (one block per path)
// ============================================================================

`).concat(i,`

// ============================================================================
// Path Query Selectors (dispatch by pathId)
// ============================================================================

`).concat(Mt(a,"queryPathPosition","position","vec2","float t, vec2 source, vec2 target","t, source, target"),`

`).concat(Mt(a,"queryPathTangent","tangent","vec2","float t, vec2 source, vec2 target","t, source, target"),`

`).concat(Mt(a,"queryPathNormal","normal","vec2","float t, vec2 source, vec2 target","t, source, target"),`

`).concat(Mt(a,"queryPathLength","length","float","vec2 source, vec2 target","source, target"),`

`).concat(Mt(a,"queryPathTAtDistance","t_at_distance","float","float dist, vec2 source, vec2 target","dist, source, target"),`

`).concat(o,`

// ============================================================================
// Shared helpers (body bounds, alpha ramp, screen direction, perpendicular offset)
// ============================================================================

`).concat(Zu,`
`).concat(Qu(t,e),`
`).concat(Ju,`
`).concat(ed,`
`)}var td=we.fontSize,nd=new Map,_i=24,ti=(_i+1)*2;function ad(n){var a=n.paths,t=n.fontSizeMode,e=n.headLengthRatio,r=n.tailLengthRatio,i=n.minVisibilityThreshold,o=n.fullVisibilityThreshold,s=n.keepUpright,l=t==="scaled",u=Xe(),d=Te([].concat($(a),[u])),h=Ht(d),c=`#version 300 es

// Per-instance attributes
in float a_edgeIndex;
in float a_edgeAttrIndex;
in float a_baseFontSize;
in float a_totalTextWidth;
in float a_positionMode;
in float a_margin;
in float a_padding;
in vec4 a_color;
in vec4 a_id;

// Per-vertex (constant) attribute: strip vertex index
in float a_vertexIndex;

uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_correctionRatio;
uniform float u_pixelRatio;
uniform float u_cameraAngle;
uniform vec2 u_resolution;
uniform sampler2D u_nodeDataTexture;
uniform int u_nodeDataTextureWidth;
uniform sampler2D u_edgeDataTexture;
uniform int u_edgeDataTextureWidth;
uniform sampler2D u_edgeFrameTexture; // Per-edge clamp (tStart, tEnd, straightenFactor, pathLength)
uniform int u_edgeFrameTextureWidth;
`.concat(l?"uniform float u_zoomSizeRatio;":"",`

`).concat(h.uniformDeclarations,`

out vec4 v_color;
out vec4 v_id;
out float v_alphaModifier;

const float ATLAS_FONT_SIZE = `).concat(re(td),`;
const float HEAD_RATIO = `).concat(re(e),`;
const float TAIL_RATIO = `).concat(re(r),`;
const int RIBBON_SEGMENTS = `).concat(_i,`;

// Path attribute varyings (declared as plain locals since this shader has no FS inputs for them)
`).concat(h.vertexVaryingDeclarations.replace(/out /g,""),`

// Node size variables used by some path functions (self-loops, etc.)
float v_sourceNodeSize;
float v_targetNodeSize;

// Shared preamble: shape SDFs, path functions + selectors, clamp, helpers.
`).concat(xi({paths:a,minVisibilityThreshold:i,fullVisibilityThreshold:o}),`

void main() {
  int vIdx = int(a_vertexIndex);
  int pairIdx = vIdx / 2;
  int side = vIdx - pairIdx * 2; // 0 = left/bottom, 1 = right/top

  // --- Fetch edge data (2 texels per edge) ---
  int edgeIdx = int(a_edgeIndex);
  int texel0Idx = edgeIdx * 2;
  int texel1Idx = edgeIdx * 2 + 1;
  ivec2 e0 = ivec2(texel0Idx % u_edgeDataTextureWidth, texel0Idx / u_edgeDataTextureWidth);
  ivec2 e1 = ivec2(texel1Idx % u_edgeDataTextureWidth, texel1Idx / u_edgeDataTextureWidth);
  vec4 edgeData0 = texelFetch(u_edgeDataTexture, e0, 0);
  vec4 edgeData1 = texelFetch(u_edgeDataTexture, e1, 0);

  int srcIdx = int(edgeData0.x);
  int tgtIdx = int(edgeData0.y);
  float thickness = edgeData0.z;
  int pathId = int(edgeData1.z);

  // --- Fetch path attributes (curvature, etc.) ---
  {
    int edgeIdx = int(a_edgeAttrIndex);
`).concat(h.fetchCode,`
`).concat(h.varyingAssignments,`
  }

  // --- Fetch node data: geometry (texel 0) + rotation flags (texel 1) ---
  vec4 srcN = readNodeData(u_nodeDataTexture, u_nodeDataTextureWidth, srcIdx);
  vec4 tgtN = readNodeData(u_nodeDataTexture, u_nodeDataTextureWidth, tgtIdx);

  vec2 source = srcN.xy;
  vec2 target = tgtN.xy;
  float sourceSize = srcN.z;
  float targetSize = tgtN.z;
  v_sourceNodeSize = sourceSize;
  v_targetNodeSize = targetSize;

  // --- Pixel-to-graph conversion (fixed font mode) ---
  float matrixScaleX = length(vec2(u_matrix[0][0], u_matrix[1][0]));
  float pixelToGraph = 2.0 / (matrixScaleX * u_resolution.x);

  float webGLThickness = thickness * u_correctionRatio / u_sizeRatio;

  // --- Body bounds (shared with edge label shader) ---
  vec4 edgeClamp = readFrameTexel(u_edgeFrameTexture, u_edgeFrameTextureWidth, edgeIdx);
  vec3 bodyBounds = computeEdgeLabelBodyBounds(
    edgeClamp.x, edgeClamp.y, edgeClamp.w,
    webGLThickness, HEAD_RATIO, TAIL_RATIO
  );
  float bodyStartDist = bodyBounds.x;
  float bodyEndDist = bodyBounds.y;
  float bodyLength = bodyBounds.z;

  // --- Text dimensions ---
  float baseFontSize = a_baseFontSize;
  `).concat(l?`float fontScale = baseFontSize / ATLAS_FONT_SIZE * u_zoomSizeRatio;
  float textWidthWebGL = a_totalTextWidth * fontScale * u_correctionRatio / u_sizeRatio;
  float halfTextHeight = baseFontSize * 0.35 * u_zoomSizeRatio * u_correctionRatio / u_sizeRatio;
  float marginWebGL = a_margin * u_zoomSizeRatio * u_correctionRatio / u_sizeRatio;`:`float fontScale = baseFontSize / ATLAS_FONT_SIZE;
  float textWidthWebGL = a_totalTextWidth * fontScale * pixelToGraph;
  float halfTextHeight = baseFontSize * 0.35 * pixelToGraph;
  float marginWebGL = a_margin * pixelToGraph;`,`
  float paddingWebGL = a_padding * pixelToGraph;

  // --- Alpha modifier (shared with edge label shader) ---
  float alphaModifier = computeEdgeLabelAlpha(bodyLength, textWidthWebGL);
  if (alphaModifier <= 0.0 || textWidthWebGL <= 0.0) {
    gl_Position = vec4(2.0, 0.0, 0.0, 1.0);
    v_color = vec4(0.0);
    v_id = vec4(0.0);
    v_alphaModifier = 0.0;
    return;
  }

  // --- Perpendicular offset (shared with edge label shader) ---
  float bodyCenterDist = (bodyStartDist + bodyEndDist) * 0.5;
  float centerT = queryPathTAtDistance(pathId, bodyCenterDist, source, target);
  float screenDir = computeEdgeLabelScreenDir(pathId, centerT, source, target, u_matrix);
  float readingSign = `).concat(s?"screenDir":"1.0",`;
  float halfThickness = webGLThickness * 0.5;
  float perpOffset = computeEdgeLabelPerpOffset(
    a_positionMode, halfThickness, marginWebGL, halfTextHeight, readingSign, screenDir
  );

  // --- Ribbon span (clipped to body) ---
  float halfTextWebGL = textWidthWebGL * 0.5;
  float labelStartDist = max(bodyCenterDist - halfTextWebGL, bodyStartDist);
  float labelEndDist = min(bodyCenterDist + halfTextWebGL, bodyEndDist);

  // Sample centerline at this pair, then apply perpendicular offset.
  // The ribbon follows the centerline path (simple & robust); for curved edges
  // this closely matches the offset path the characters sit on.
  float u = float(pairIdx) / float(RIBBON_SEGMENTS);
  float arcDist = mix(labelStartDist, labelEndDist, u);
  float t = queryPathTAtDistance(pathId, arcDist, source, target);
  vec2 pos = queryPathPosition(pathId, t, source, target);
  vec2 tan = queryPathTangent(pathId, t, source, target);
  vec2 perp = vec2(-tan.y, tan.x);

  vec2 centerPos = pos + perp * perpOffset;

  float halfRibbon = halfTextHeight + paddingWebGL;
  float sideSign = side == 0 ? -1.0 : 1.0;
  vec2 ribbonPos = centerPos + perp * (sideSign * halfRibbon);

  vec3 clipPos = u_matrix * vec3(ribbonPos, 1.0);
  gl_Position = vec4(clipPos.xy, 0.0, 1.0);

  v_color = a_color;
  v_id = a_id;
  v_alphaModifier = alphaModifier;
}
`);return c}var rd=`#version 300 es
precision highp float;

in vec4 v_color;
in vec4 v_id;
in float v_alphaModifier;

out vec4 fragColor;

void main() {
#ifdef PICKING_MODE
  if (v_alphaModifier <= 0.0) discard;
  fragColor = v_id;
#else
  float alpha = v_color.a * v_alphaModifier;
  if (alpha <= 0.0) discard;
  fragColor = vec4(v_color.rgb * alpha, alpha);
#endif
}
`;function id(n,a,t,e){var r=e.shaderConfig,i=r.paths,o=r.fontSizeMode;if(i.length===0)throw new Error("createEdgeLabelBackgroundProgram: shaderConfig must declare at least one path");var s=Xe(),l=Te([].concat($(i),[s])),u=kn([].concat($(i),[s]),l),d=ad(r),h=function(c){function f(g,m,p){var v;return Y(this,f),v=te(this,f,[g,m,p]),E(v,"totalCount",0),E(v,"bufferCapacity",0),E(v,"edgeAttributeTexture",null),v.edgeAttributeTexture=new Ln(g,l),v.packedAttributeData=new Float32Array(l.floatsPerItem),v}return ne(f,c),K(f,[{key:"getDefinition",value:function(){for(var m=WebGL2RenderingContext,p=m.FLOAT,v=m.UNSIGNED_BYTE,y=m.TRIANGLE_STRIP,b=[],T=0;T<ti;T++)b.push([T]);var x=["u_matrix","u_sizeRatio","u_correctionRatio","u_pixelRatio","u_cameraAngle","u_resolution","u_nodeDataTexture","u_nodeDataTextureWidth","u_edgeDataTexture","u_edgeDataTextureWidth","u_edgeFrameTexture","u_edgeFrameTextureWidth"];return o==="scaled"&&x.push("u_zoomSizeRatio"),l.floatsPerItem>0&&x.push("u_edgeAttributeTexture","u_edgeAttributeTextureWidth","u_edgeAttributeTexelsPerEdge"),{VERTICES:ti,VERTEX_SHADER_SOURCE:d,FRAGMENT_SHADER_SOURCE:rd,METHOD:y,UNIFORMS:x,ATTRIBUTES:[{name:"a_edgeIndex",size:1,type:p},{name:"a_edgeAttrIndex",size:1,type:p},{name:"a_baseFontSize",size:1,type:p},{name:"a_totalTextWidth",size:1,type:p},{name:"a_positionMode",size:1,type:p},{name:"a_margin",size:1,type:p},{name:"a_padding",size:1,type:p},{name:"a_color",size:4,type:v,normalized:!0},{name:"a_id",size:4,type:v,normalized:!0}],CONSTANT_ATTRIBUTES:[{name:"a_vertexIndex",size:1,type:p}],CONSTANT_DATA:b}}},{key:"processEdgeLabelBackground",value:function(m,p,v){var y=0;if(this.edgeAttributeTexture&&l.floatsPerItem>0){y=this.edgeAttributeTexture.allocate(p);var b=this.packedAttributeData;Pn(u,v.edgeAttributes,b,"",nd,0),this.edgeAttributeTexture.updateAllAttributes(p,b)}var T=this.floats,x=this.ints,_=m*this.STRIDE;T[_++]=v.edgeIndex,T[_++]=y,T[_++]=v.baseFontSize,T[_++]=v.totalTextWidth,T[_++]=v.positionMode,T[_++]=v.margin,T[_++]=v.padding,T[_++]=v.color,x[_++]=v.id}},{key:"setUniforms",value:function(m,p){var v=p.gl,y=p.uniformLocations;if(v.uniformMatrix3fv(y.u_matrix,!1,m.matrix),v.uniform1f(y.u_sizeRatio,m.sizeRatio),v.uniform1f(y.u_correctionRatio,m.correctionRatio),v.uniform1f(y.u_pixelRatio,m.pixelRatio),v.uniform1f(y.u_cameraAngle,m.cameraAngle),v.uniform2f(y.u_resolution,m.width,m.height),y.u_nodeDataTexture!==void 0&&v.uniform1i(y.u_nodeDataTexture,m.nodeDataTextureUnit),y.u_nodeDataTextureWidth!==void 0&&v.uniform1i(y.u_nodeDataTextureWidth,m.nodeDataTextureWidth),y.u_edgeDataTexture!==void 0&&v.uniform1i(y.u_edgeDataTexture,m.edgeDataTextureUnit),y.u_edgeDataTextureWidth!==void 0&&v.uniform1i(y.u_edgeDataTextureWidth,m.edgeDataTextureWidth),y.u_edgeFrameTexture!==void 0&&v.uniform1i(y.u_edgeFrameTexture,m.edgeFrameTextureUnit),y.u_edgeFrameTextureWidth!==void 0&&v.uniform1i(y.u_edgeFrameTextureWidth,m.edgeFrameTextureWidth),o==="scaled"&&y.u_zoomSizeRatio!==void 0){var b=this.renderer.getSetting("zoomToSizeRatioFunction");v.uniform1f(y.u_zoomSizeRatio,1/b(m.zoomRatio))}this.edgeAttributeTexture&&l.floatsPerItem>0&&y.u_edgeAttributeTexture!==void 0&&(this.edgeAttributeTexture.bind(Ue),v.uniform1i(y.u_edgeAttributeTexture,Ue),v.uniform1i(y.u_edgeAttributeTextureWidth,this.edgeAttributeTexture.getTextureWidth()),v.uniform1i(y.u_edgeAttributeTexelsPerEdge,this.edgeAttributeTexture.getTexelsPerItem()))}},{key:"renderProgram",value:function(m,p){this.edgeAttributeTexture&&l.floatsPerItem>0&&this.edgeAttributeTexture.upload(),se(f,"renderProgram",this,3)([m,p])}},{key:"kill",value:function(){this.edgeAttributeTexture&&(this.edgeAttributeTexture.kill(),this.edgeAttributeTexture=null),se(f,"kill",this,3)([])}},{key:"drawWebGL",value:function(m,p){var v=p.gl;this.totalCount!==0&&v.drawArraysInstanced(v.TRIANGLE_STRIP,0,this.VERTICES,this.totalCount)}},{key:"reallocate",value:function(m){this.totalCount=m,m>this.bufferCapacity&&(this.bufferCapacity=Math.max(m,Math.ceil(this.bufferCapacity*1.5)||10),se(f,"reallocate",this,3)([this.bufferCapacity]))}}])}(Ze);return new h(n,a,t)}function Ti(n){var a,t,e,r,i,o;return{paths:n.paths,headLengthRatio:(a=n.headLengthRatio)!==null&&a!==void 0?a:0,tailLengthRatio:(t=n.tailLengthRatio)!==null&&t!==void 0?t:0,fontSizeMode:(e=n.fontSizeMode)!==null&&e!==void 0?e:"fixed",minVisibilityThreshold:(r=n.minVisibilityThreshold)!==null&&r!==void 0?r:.7,fullVisibilityThreshold:(i=n.fullVisibilityThreshold)!==null&&i!==void 0?i:.8,keepUpright:(o=n.keepUpright)!==null&&o!==void 0?o:!0}}var od=we.fontSize,sd=17/64;function ld(n){var a=n.paths,t=n.hasBorder,e=t===void 0?!1:t,r=n.fontSizeMode,i=r===void 0?"fixed":r,o=n.minVisibilityThreshold,s=o===void 0?.5:o,l=n.fullVisibilityThreshold,u=l===void 0?.6:l,d=n.keepUpright,h=d===void 0?!0:d,c=i==="scaled",f=a.some(function(y){return y.hasSharpCorners}),g=Xe(),m=Te([].concat($(a),[g])),p=Ht(m),v=`#version 300 es

// ============================================================================
// Attributes - Per Character (Instanced)
// ============================================================================

// Edge geometry: indices for texture lookup
// Edge data (source/target node indices, thickness, head/tail ratios) is fetched from edge data texture
// Edge path attributes (curvature, etc.) are fetched from edge attribute texture
in float a_edgeIndex;       // Index into edge data texture
in float a_edgeAttrIndex;   // Index into edge attribute texture (for curvature, etc.)
in float a_baseFontSize;    // Base font size in pixels (per-label)

// Character metrics (in glyph units = atlas font size pixels)
in vec4 a_charMetrics;      // (charTextOffset, charAdvance, totalTextWidth, positionMode)
in vec4 a_charDims;         // (charSize.x, charSize.y, charOffset.x, charOffset.y)

// Atlas texture coordinates
in vec4 a_texCoords;        // (x, y, width, height) in atlas pixels

// Label parameters
in vec2 a_labelParams;      // (margin, unused)

// Appearance
in vec4 a_color;            // Character color (RGBA, normalized)
`.concat(e?"in vec4 a_borderColor;      // Border color (RGBA, normalized)":"",`

// ============================================================================
// Attributes - Per Vertex (Constant)
// ============================================================================

in vec2 a_quadCorner;       // Quad corner: (0,0), (1,0), (0,1), (1,1)

// ============================================================================
// Uniforms
// ============================================================================

uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_correctionRatio;
uniform float u_pixelRatio;
uniform float u_cameraAngle;    // Required by node shape SDFs
// u_sdfBufferPixels kept for ABI compatibility but unused in shader
uniform float u_sdfBufferPixels;
uniform vec2 u_resolution;
uniform vec2 u_atlasSize;
uniform sampler2D u_nodeDataTexture; // Shared texture with node position/size/shape data
uniform int u_nodeDataTextureWidth;  // Width of 2D node data texture for coordinate calculation
uniform sampler2D u_edgeDataTexture; // Shared texture with edge data
uniform int u_edgeDataTextureWidth;  // Width of 2D edge data texture for coordinate calculation
uniform sampler2D u_edgeFrameTexture; // Per-edge clamp (tStart, tEnd, straightenFactor, pathLength)
uniform int u_edgeFrameTextureWidth;
`).concat(c?"uniform float u_zoomSizeRatio;  // Zoom-based size ratio from zoomToSizeRatioFunction":"",`

// Edge path attribute texture uniforms (for curvature and other path attributes)
`).concat(p.uniformDeclarations,`

// ============================================================================
// Varyings
// ============================================================================

out vec2 v_texCoord;
out vec4 v_color;
`).concat(e?"out vec4 v_borderColor;":"",`
out float v_edgeFade;  // 0 = fully visible, 1 = fully faded (outside body)
out float v_alphaModifier;  // 0-1 based on label visibility ratio
out float v_fontScale;  // Ratio of rendered font size to atlas font size
`).concat(e?"out float v_positionMode;  // Position mode for conditional border (0=over needs border)":"",`

// ============================================================================
// Constants
// ============================================================================

const float bias = 255.0 / 254.0;
const float FADE_WIDTH_PIXELS = 15.0;  // Width of fade gradient in pixels
const float ATLAS_FONT_SIZE = `).concat(re(od),`;  // Base font size used in SDF atlas
const float VERTICAL_CENTER_RATIO = `).concat(re(sd),`;  // Baseline to visual center ratio

// ============================================================================
// Path Attribute Variables (set in main, used by path functions)
// ============================================================================
// Path attributes are fetched from the edge attribute texture and stored in
// variables with v_ prefix (e.g., v_curvature) for path functions to access.
`).concat(p.vertexVaryingDeclarations.replace(/out /g,""),`

// Node size variables (set in main, used by some path functions like loops).
// These mirror the v_sourceNodeSize / v_targetNodeSize varyings in generator.ts,
// but are plain floats here since the label shader is vertex-only.
float v_sourceNodeSize;
float v_targetNodeSize;

// Shared preamble: shape SDFs, path functions + selectors, clamp, helpers.
`).concat(xi({paths:a,minVisibilityThreshold:s,fullVisibilityThreshold:u}),`

// ============================================================================
// Main
// ============================================================================

void main() {
  // -------------------------------------------------------------------------
  // Fetch edge data from edge texture (2 texels per edge)
  // -------------------------------------------------------------------------
  // Texel 0: sourceNodeIndex, targetNodeIndex, thickness, reserved
  // Texel 1: headLengthRatio, tailLengthRatio, pathId, extremityIds
  int edgeIdx = int(a_edgeIndex);
  int texel0Idx = edgeIdx * 2;
  int texel1Idx = edgeIdx * 2 + 1;
  ivec2 edgeTexCoord0 = ivec2(texel0Idx % u_edgeDataTextureWidth, texel0Idx / u_edgeDataTextureWidth);
  ivec2 edgeTexCoord1 = ivec2(texel1Idx % u_edgeDataTextureWidth, texel1Idx / u_edgeDataTextureWidth);
  vec4 edgeData0 = texelFetch(u_edgeDataTexture, edgeTexCoord0, 0);
  vec4 edgeData1 = texelFetch(u_edgeDataTexture, edgeTexCoord1, 0);

  // Unpack edge data
  int srcIdx = int(edgeData0.x);
  int tgtIdx = int(edgeData0.y);
  float thickness = edgeData0.z;
  // edgeData0.w is reserved
  float headLengthRatio = edgeData1.x;
  float tailLengthRatio = edgeData1.y;
  int pathId = int(edgeData1.z);  // Path type for multi-path support
  float baseFontSize = a_baseFontSize;

  // -------------------------------------------------------------------------
  // Fetch path attributes from edge attribute texture
  // -------------------------------------------------------------------------
  // Note: The fetch code uses 'edgeIdx' variable, so we set it to the attribute texture index
  {
    int edgeIdx = int(a_edgeAttrIndex);  // Use attribute texture index for path attributes
`).concat(p.fetchCode,`
`).concat(p.varyingAssignments,`
  }

  // -------------------------------------------------------------------------
  // Fetch node data from node texture (geometry texel + rotation-flags texel)
  // -------------------------------------------------------------------------
  vec4 srcNodeData = readNodeData(u_nodeDataTexture, u_nodeDataTextureWidth, srcIdx);
  vec4 tgtNodeData = readNodeData(u_nodeDataTexture, u_nodeDataTextureWidth, tgtIdx);

  vec2 source = srcNodeData.xy;
  vec2 target = tgtNodeData.xy;
  float sourceSize = srcNodeData.z;
  float targetSize = tgtNodeData.z;
  v_sourceNodeSize = sourceSize;
  v_targetNodeSize = targetSize;
  float charTextOffset = a_charMetrics.x;
  float charAdvance = a_charMetrics.y;
  float totalTextWidth = a_charMetrics.z;
  float positionMode = a_charMetrics.w;
  vec2 charSize = a_charDims.xy;
  vec2 charOffset = a_charDims.zw;
  float margin = a_labelParams.x;

  // -------------------------------------------------------------------------
  // Compute pixel-to-graph conversion (for fixed font size mode)
  // -------------------------------------------------------------------------
  // This converts screen pixels to graph units such that N pixels on screen
  // becomes N pixels regardless of zoom level.
  // matrixScaleX is how much the matrix scales graph units to clip space
  float matrixScaleX = length(vec2(u_matrix[0][0], u_matrix[1][0]));
  float pixelToGraph = 2.0 / (matrixScaleX * u_resolution.x);

  // -------------------------------------------------------------------------
  // Step 1: Convert thickness to WebGL units
  // -------------------------------------------------------------------------
  float webGLThickness = thickness * u_correctionRatio / u_sizeRatio;

  // -------------------------------------------------------------------------
  // Step 2: Compute body bounds (truncated at node boundaries + extremities)
  // -------------------------------------------------------------------------
  vec4 edgeClamp = readFrameTexel(u_edgeFrameTexture, u_edgeFrameTextureWidth, edgeIdx);
  vec3 bodyBounds = computeEdgeLabelBodyBounds(
    edgeClamp.x, edgeClamp.y, edgeClamp.w,
    webGLThickness, headLengthRatio, tailLengthRatio
  );
  float bodyStartDist = bodyBounds.x;
  float bodyEndDist = bodyBounds.y;
  float bodyLength = bodyBounds.z;

  // -------------------------------------------------------------------------
  // Step 3: Compute font scale and text dimensions
  // -------------------------------------------------------------------------
  // Font size modes:
  // - "fixed": Constant pixel size regardless of zoom, using pixelToGraph conversion
  // - "scaled": Scales with zoom using zoomToSizeRatioFunction
  `).concat(c?`// Scaled mode: font scales with zoom
  float fontScale = baseFontSize / ATLAS_FONT_SIZE * u_zoomSizeRatio;
  // Convert glyph-unit metrics to WebGL units (scales with zoom)
  float textWidthWebGL = totalTextWidth * fontScale * u_correctionRatio / u_sizeRatio;
  float charOffsetWebGL = charTextOffset * fontScale * u_correctionRatio / u_sizeRatio;
  float charAdvanceWebGL = charAdvance * fontScale * u_correctionRatio / u_sizeRatio;`:`// Fixed mode: font stays constant in screen pixels
  float fontScale = baseFontSize / ATLAS_FONT_SIZE;
  // Convert glyph-unit metrics to graph units using pixelToGraph (zoom-independent)
  float textWidthWebGL = totalTextWidth * fontScale * pixelToGraph;
  float charOffsetWebGL = charTextOffset * fontScale * pixelToGraph;
  float charAdvanceWebGL = charAdvance * fontScale * pixelToGraph;`,`

  // Font scale varying for fragment shader gamma scaling.
  // Ratio of rendered font size to atlas font size \u2014 used to tighten the
  // anti-aliasing band for large labels so they stay sharp.
  v_fontScale = fontScale;

  // -------------------------------------------------------------------------
  // Step 4: Alpha modifier from how much of the label fits in the body
  // -------------------------------------------------------------------------
  float alphaModifier = computeEdgeLabelAlpha(bodyLength, textWidthWebGL);

  // -------------------------------------------------------------------------
  // Step 5: Compute character center offset (truncation check moved to after curvature adjustment)
  // -------------------------------------------------------------------------
  // Body center in arc distance
  float bodyCenterDist = (bodyStartDist + bodyEndDist) * 0.5;

  float centerT = queryPathTAtDistance(pathId, bodyCenterDist, source, target);
  float screenDir = computeEdgeLabelScreenDir(pathId, centerT, source, target, u_matrix);

  // Reversed labels lay their characters out from target to source
  float readingSign = `).concat(h?"screenDir":"1.0",`;

  // Character center position relative to label center (on centerline, before curvature adjustment)
  float charCenterOffset = readingSign * (charOffsetWebGL + charAdvanceWebGL * 0.5 - textWidthWebGL * 0.5);

  // -------------------------------------------------------------------------
  // Step 6: Compute perpendicular offset based on position mode
  // -------------------------------------------------------------------------
  // Position modes: 0=over, 1=above, 2=below, 3=auto
  // Needed early for curvature-adaptive character spacing in Step 7
  float halfThickness = webGLThickness * 0.5;
  `).concat(c?`// Scaled mode: margin and text height scale with zoom (same factor as font)
  float marginWebGL = margin * u_zoomSizeRatio * u_correctionRatio / u_sizeRatio;
  float halfTextHeight = baseFontSize * 0.35 * u_zoomSizeRatio * u_correctionRatio / u_sizeRatio;`:`// Fixed mode: margin and text height stay constant in screen pixels
  float marginWebGL = margin * pixelToGraph;
  float halfTextHeight = baseFontSize * 0.35 * pixelToGraph;`,`
  float perpOffset = computeEdgeLabelPerpOffset(
    positionMode, halfThickness, marginWebGL, halfTextHeight, readingSign, screenDir
  );

  // -------------------------------------------------------------------------
  // Step 7: Position character on path using offset path traversal
  // -------------------------------------------------------------------------
  // For "over" mode (perpOffset = 0), use simple centerline placement
  // For above/below modes, walk along the offset path to find correct position
  float charT;

  if (perpOffset == 0.0) {
    // Simple case: place on centerline
    float charArcDist = bodyCenterDist + charCenterOffset;
    charT = queryPathTAtDistance(pathId, charArcDist, source, target);
  } else {
    // Offset path traversal: walk along the offset curve to find character position
    // This ensures even character spacing regardless of curvature

    `).concat(f?`// -----------------------------------------------------------------------
    // Corner skip setup for step/taxi edges with above/below labels
    // -----------------------------------------------------------------------
    // At concave corners (inner side of the bend), characters would bunch up
    // because the offset path has near-zero arc length. We detect corner
    // crossings during the offset path traversal and add skip distance.

    // Get corner t values and concavity
    vec2 cornerTs = queryGetCornerTs(pathId, source, target);
    vec2 concavity = queryGetCornerConcavity(pathId, source, target, perpOffset);

    // Skip distance in graph units, proportional to on-screen font size
    // For fixed mode: use pixelToGraph so gap stays constant regardless of zoom
    // For scaled mode: use the same conversion as text width
    `.concat(c?"float skipDistGraph = STEP_INNER_CORNER_SKIP_FACTOR * baseFontSize * u_zoomSizeRatio * u_correctionRatio / u_sizeRatio;":"float skipDistGraph = STEP_INNER_CORNER_SKIP_FACTOR * baseFontSize * pixelToGraph;",`

    // Corner t values for detecting crossings during traversal
    float corner1T = cornerTs.x;
    float corner2T = cornerTs.y;
    bool corner1IsConcave = concavity.x > 0.5;
    bool corner2IsConcave = concavity.y > 0.5;`):"",`

    // Target distance along offset path from center
    float targetOffsetDist = abs(charCenterOffset);

    // Handle center character (charCenterOffset \u2248 0) - no search needed
    if (targetOffsetDist < 0.0001) {
      charT = centerT;
    } else {
      vec2 centerPos = queryPathPosition(pathId, centerT, source, target);
      vec2 centerNormal = queryPathNormal(pathId, centerT, source, target);
      vec2 offsetCenter = centerPos + centerNormal * perpOffset;

      float searchDir = charCenterOffset > 0.0 ? 1.0 : -1.0;

      // Search bounds (t values for body start and end)
      float tBodyStart = queryPathTAtDistance(pathId, bodyStartDist, source, target);
      float tBodyEnd = queryPathTAtDistance(pathId, bodyEndDist, source, target);

      // Walk along offset path to find character position
      float accumDist = 0.0;
      vec2 prevOffsetPos = offsetCenter;
      float prevT = centerT;
      float foundT = centerT;

      // Search range depends on direction
      float tSearchEnd = searchDir > 0.0 ? tBodyEnd : tBodyStart;

      `).concat(f?`// Track which concave corners we've crossed to add skip distance
      bool crossedCorner1 = false;
      bool crossedCorner2 = false;
      float effectiveTargetDist = targetOffsetDist;`:"",`

      const int STEPS = 32;
      for (int i = 1; i <= STEPS; i++) {
        // Step along centerline t, from center toward target
        float stepT = centerT + searchDir * float(i) * abs(tSearchEnd - centerT) / float(STEPS);

        `).concat(f?`// Check for concave corner crossings and add skip distance
        // Corner 1 crossing check
        if (corner1IsConcave && !crossedCorner1) {
          bool crossingCorner1 = (searchDir > 0.0)
            ? (prevT < corner1T && stepT >= corner1T)
            : (prevT > corner1T && stepT <= corner1T);
          if (crossingCorner1) {
            crossedCorner1 = true;
            effectiveTargetDist += skipDistGraph;
          }
        }

        // Corner 2 crossing check
        if (corner2IsConcave && !crossedCorner2) {
          bool crossingCorner2 = (searchDir > 0.0)
            ? (prevT < corner2T && stepT >= corner2T)
            : (prevT > corner2T && stepT <= corner2T);
          if (crossingCorner2) {
            crossedCorner2 = true;
            effectiveTargetDist += skipDistGraph;
          }
        }`:"",`

        // Compute offset position at this t
        vec2 stepPos = queryPathPosition(pathId, stepT, source, target);
        vec2 stepNormal = queryPathNormal(pathId, stepT, source, target);
        vec2 offsetPos = stepPos + stepNormal * perpOffset;

        // Distance along offset path
        float segDist = length(offsetPos - prevOffsetPos);

        `).concat(f?`if (accumDist + segDist >= effectiveTargetDist) {
          // Interpolate within segment to find exact t
          float remaining = effectiveTargetDist - accumDist;
          float segT = remaining / max(segDist, 0.0001);
          foundT = mix(prevT, stepT, segT);
          break;
        }`:`if (accumDist + segDist >= targetOffsetDist) {
          // Interpolate within segment to find exact t
          float remaining = targetOffsetDist - accumDist;
          float segT = remaining / max(segDist, 0.0001);
          foundT = mix(prevT, stepT, segT);
          break;
        }`,`

        accumDist += segDist;
        prevOffsetPos = offsetPos;
        prevT = stepT;
        // Update foundT to last valid position in case loop exhausts without finding target
        foundT = stepT;
      }

      charT = foundT;
    }
  }

  // Get position and tangent at final character position
  vec2 pathPos = queryPathPosition(pathId, charT, source, target);
  vec2 tangent = queryPathTangent(pathId, charT, source, target);

  // Compute perpendicular direction (90 degrees from tangent)
  vec2 perpDir = vec2(-tangent.y, tangent.x);

  // Apply perpendicular offset to path position
  vec2 offsetPathPos = pathPos + perpDir * perpOffset;

  // -------------------------------------------------------------------------
  // Step 8: Build character quad
  // -------------------------------------------------------------------------
  // Character size in screen pixels
  vec2 charSizePixels = charSize * fontScale;

  // Character offset from origin to the atlas region's top-left corner.
  // bearingX/bearingY already include the SDF buffer.
  vec2 charOffsetPixels = charOffset * fontScale;

  // The character's local X offset from pathPos (which is at character center)
  float charLocalX = -charAdvance * 0.5 * fontScale;

  // Build quad position:
  // - Start at character origin (charLocalX on X axis, 0 on Y axis = baseline)
  // - Add bearing offset to get to atlas region corner
  // - Add quad corner * size to get vertex position
  vec2 quadPos;
  quadPos.x = charLocalX + charOffsetPixels.x + a_quadCorner.x * charSizePixels.x;
  // charOffset.y = -bearingY (negated), so -charOffsetPixels.y = bearingY * fontScale
  // (distance from baseline to atlas region top, positive = upward)
  // Quad corner (0,0) = bottom-left, (1,1) = top-right
  quadPos.y = -charOffsetPixels.y - charSizePixels.y * (1.0 - a_quadCorner.y);

  // Center vertically on the path by offsetting by half the visual text height
  // VERTICAL_CENTER_RATIO is the distance from baseline to visual center as a ratio of atlas font size
  float verticalCenterOffset = VERTICAL_CENTER_RATIO * ATLAS_FONT_SIZE * fontScale;
  quadPos.y -= verticalCenterOffset;

  // -------------------------------------------------------------------------
  // Step 9: Rotate quad to align with tangent
  // -------------------------------------------------------------------------
  // Rotation matrix from the reading direction
  // readingDir = (cos(angle), sin(angle)), so we can build rotation directly
  vec2 readingDir = tangent * readingSign;
  mat2 rotation = mat2(readingDir.x, readingDir.y, -readingDir.y, readingDir.x);

  // Convert pixel offset to WebGL units for rotation
  `).concat(c?"vec2 quadPosWebGL = quadPos * u_correctionRatio / u_sizeRatio; // Scaled mode":"vec2 quadPosWebGL = quadPos * pixelToGraph; // Fixed mode: use pixelToGraph for zoom-independent size",`

  // Rotate around character center on path
  vec2 rotatedOffset = rotation * quadPosWebGL;

  // Final position in graph space (using offset path position for above/below modes)
  vec2 worldPos = offsetPathPos + rotatedOffset;

  // -------------------------------------------------------------------------
  // Step 10: Transform to clip space
  // -------------------------------------------------------------------------
  vec3 clipPos = u_matrix * vec3(worldPos, 1.0);
  gl_Position = vec4(clipPos.xy, 0.0, 1.0);

  // -------------------------------------------------------------------------
  // Step 11: Texture coordinates
  // -------------------------------------------------------------------------
  // Flip Y for texture coordinates (texture Y goes down, quad Y goes up)
  vec2 texCorner = vec2(a_quadCorner.x, 1.0 - a_quadCorner.y);
  v_texCoord = (a_texCoords.xy + texCorner * a_texCoords.zw) / u_atlasSize;

  // -------------------------------------------------------------------------
  // Step 12: Pass color, border color, and alpha modifier
  // -------------------------------------------------------------------------
  v_color = a_color;
  v_color.a *= bias;
`).concat(e?`  v_borderColor = a_borderColor;
  v_borderColor.a *= bias;
  v_positionMode = positionMode;`:"",`
  v_alphaModifier = alphaModifier;

  // -------------------------------------------------------------------------
  // Step 13: Compute edge fade for soft truncation
  // -------------------------------------------------------------------------
  // Convert fade width from pixels to WebGL units
  `).concat(c?"float fadeWidthWebGL = FADE_WIDTH_PIXELS * u_correctionRatio / u_sizeRatio;":"float fadeWidthWebGL = FADE_WIDTH_PIXELS * pixelToGraph;",`

  // Compute the arc position of THIS VERTEX (not just character center)
  // The quad extends from charCenter - advance/2 to charCenter + advance/2
  // a_quadCorner.x is 0 for left edge, 1 for right edge
  float vertexLocalOffset = readingSign * (a_quadCorner.x - 0.5) * charAdvanceWebGL;
  float vertexArcOffset = charCenterOffset + vertexLocalOffset;

  // Compute distance from body edges (positive = inside body, negative = outside)
  float halfBody = bodyLength * 0.5;
  float distFromStart = vertexArcOffset + halfBody;  // Distance from body start edge
  float distFromEnd = halfBody - vertexArcOffset;    // Distance from body end edge
  float distFromEdge = min(distFromStart, distFromEnd);

  // Compute fade: 0 = fully visible (deep inside body), 1 = fully faded (at body edge)
  // Fade goes from 0 (at 2*fadeWidth inside) to 1 (at body edge)
  // This ensures text is fully transparent before reaching extremities
  v_edgeFade = 1.0 - smoothstep(0.0, fadeWidthWebGL * 2.0, distFromEdge);
}
`);return v}function ud(){var n=arguments.length>0&&arguments[0]!==void 0?arguments[0]:{},a=n.hasBorder,t=a===void 0?!1:a,e=`#version 300 es
precision highp float;

in vec2 v_texCoord;
in vec4 v_color;
`.concat(t?"in vec4 v_borderColor;":"",`
in float v_edgeFade;  // 0 = fully visible, 1 = fully faded
in float v_alphaModifier;  // 0-1 based on label visibility ratio
in float v_fontScale;  // Ratio of rendered font size to atlas font size
`).concat(t?"in float v_positionMode;  // Position mode (0=over, 1=above, 2=below, 3=auto)":"",`

uniform sampler2D u_atlas;
uniform float u_gamma;
uniform float u_sdfBuffer;
uniform float u_pixelRatio;
`).concat(t?"uniform float u_borderWidth;  // Border width in SDF units (normalized)":"",`

// Fragment output (single target - picking handled via separate pass)
out vec4 fragColor;

void main() {
  #ifdef PICKING_MODE
    // Edge labels are not pickable - discard all fragments in picking mode
    fragColor = vec4(0.0);
    discard;
  #else
  // SDF stores normalized distance: 0.5 = on edge, >0.5 = inside glyph
  float sdfValue = texture(u_atlas, v_texCoord).a;

  // Edge threshold accounting for SDF buffer padding
  float edge = 1.0 - u_sdfBuffer;

  // Scale gamma inversely with font scale so small labels get a wider AA band
  // (smoother) and large labels get a tighter band (sharper).
  float aaWidth = u_gamma / (u_pixelRatio * v_fontScale);

  // Apply edge fade for soft truncation at body boundaries
  // Also apply visibility-based alpha modifier for short edge labels
  float edgeAlpha = (1.0 - v_edgeFade) * v_alphaModifier;

`).concat(t?`  // Fill alpha: fully opaque inside the glyph
  float fillAlpha = smoothstep(edge - aaWidth, edge + aaWidth, sdfValue);

  // Only apply border for "over" position mode (v_positionMode == 0.0)
  // Labels positioned above/below/auto don't overlap the edge line and don't need borders
  if (v_positionMode < 0.5) {
    // Border rendering: compute alpha for both fill and border regions
    // Border extends from (edge - borderWidth) to edge
    float borderEdge = edge - u_borderWidth;

    // Border alpha: opaque in the border region (between borderEdge and edge)
    float borderAlpha = smoothstep(borderEdge - aaWidth, borderEdge + aaWidth, sdfValue);

    // Composite: fill on top of border
    // Border is visible where borderAlpha > 0 but fillAlpha < 1
    vec3 borderColorPremult = v_borderColor.rgb * v_borderColor.a * borderAlpha * edgeAlpha;
    vec3 fillColorPremult = v_color.rgb * v_color.a * fillAlpha * edgeAlpha;

    // Blend fill over border (fill replaces border where fill is opaque)
    float finalBorderAlpha = borderAlpha * (1.0 - fillAlpha);
    vec3 finalColor = fillColorPremult + v_borderColor.rgb * v_borderColor.a * finalBorderAlpha * edgeAlpha;
    float finalAlpha = (v_color.a * fillAlpha + v_borderColor.a * finalBorderAlpha) * edgeAlpha;

    fragColor = vec4(finalColor, finalAlpha);
  } else {
    // No border for above/below/auto positions - simple text rendering
    float finalAlpha = v_color.a * fillAlpha * edgeAlpha;
    fragColor = vec4(v_color.rgb * finalAlpha, finalAlpha);
  }`:`  // Smooth transition from transparent to opaque at glyph edge
  float alpha = smoothstep(edge - aaWidth, edge + aaWidth, sdfValue);

  // Premultiplied alpha output
  float finalAlpha = v_color.a * alpha * edgeAlpha;
  fragColor = vec4(v_color.rgb * finalAlpha, finalAlpha);`,`
  #endif
}
`);return e}function dd(n){var a=arguments.length>1&&arguments[1]!==void 0?arguments[1]:!1,t=arguments.length>2&&arguments[2]!==void 0?arguments[2]:"fixed",e=["u_matrix","u_sizeRatio","u_correctionRatio","u_pixelRatio","u_cameraAngle","u_sdfBufferPixels","u_resolution","u_atlasSize","u_atlas","u_gamma","u_sdfBuffer","u_nodeDataTexture","u_nodeDataTextureWidth","u_edgeDataTexture","u_edgeDataTextureWidth","u_edgeFrameTexture","u_edgeFrameTextureWidth","u_edgeAttributeTexture","u_edgeAttributeTextureWidth","u_edgeAttributeTexelsPerEdge"];t==="scaled"&&e.push("u_zoomSizeRatio"),a&&e.push("u_borderWidth");var r=z(n),i;try{for(r.s();!(i=r.n()).done;){var o=i.value,s=z(o.uniforms),l;try{for(s.s();!(l=s.n()).done;){var u=l.value;e.includes(u.name)||e.push(u.name)}}catch(d){s.e(d)}finally{s.f()}}}catch(d){r.e(d)}finally{r.f()}return e}function hd(n){var a=n.hasBorder,t=a===void 0?!1:a,e=n.fontSizeMode,r=e===void 0?"fixed":e;return{vertexShader:ld(n),fragmentShader:ud({hasBorder:t}),uniforms:dd(n.paths,t,r)}}var cd=new Map;function fd(n){switch(n){case"over":return 0;case"above":return 1;case"below":return 2;case"auto":return 3;default:return 0}}function gd(n,a,t,e){var r=e.color,i=e.margin,o=e.textBorder,s=Ti(e),l=s.paths,u=s.fontSizeMode,d=s.minVisibilityThreshold,h=s.fullVisibilityThreshold,c=s.keepUpright,f=!!o,g=hd({paths:l,hasBorder:f,fontSizeMode:u,minVisibilityThreshold:d,fullVisibilityThreshold:h,keepUpright:c}),m=function(p){function v(y,b,T){var x;Y(this,v),x=te(this,v,[y,b,T]),E(x,"atlasTexture",null),E(x,"atlasNeedsUpdate",!1),E(x,"refreshTimeout",null),E(x,"labelGlyphCache",new Map),E(x,"edgeAttributeTexture",null);var _=Xe();if(x.attributeLayout=Te([].concat($(l),[_])),x.attrDescriptors=kn([].concat($(l),[_]),x.attributeLayout),x.edgeAttributeTexture=new Ln(y,x.attributeLayout),x.packedAttributeData=new Float32Array(x.attributeLayout.floatsPerItem),x.atlasManager=new Ye,x.gamma=.025,x.sdfBuffer=we.cutoff,x.atlasTexture=y.createTexture(),!x.atlasTexture)throw new Error("EdgeLabelProgram: failed to create atlas texture");y.bindTexture(y.TEXTURE_2D,x.atlasTexture),y.texParameteri(y.TEXTURE_2D,y.TEXTURE_WRAP_S,y.CLAMP_TO_EDGE),y.texParameteri(y.TEXTURE_2D,y.TEXTURE_WRAP_T,y.CLAMP_TO_EDGE),y.texParameteri(y.TEXTURE_2D,y.TEXTURE_MIN_FILTER,y.LINEAR),y.texParameteri(y.TEXTURE_2D,y.TEXTURE_MAG_FILTER,y.LINEAR),y.bindTexture(y.TEXTURE_2D,null),x.atlasManager.on(Ye.ATLAS_UPDATED_EVENT,function(){x.atlasNeedsUpdate=!0,x.refreshTimeout!==null&&clearTimeout(x.refreshTimeout),x.refreshTimeout=setTimeout(function(){x.refreshTimeout=null,x.renderer.refresh()},0)});var S={family:"sans-serif",weight:"normal",style:"normal"};return x.defaultFontKey=x.atlasManager.registerFont(S),x}return ne(v,p),K(v,[{key:"getDefinition",value:function(){var b=WebGL2RenderingContext,T=b.FLOAT,x=b.UNSIGNED_BYTE,_=b.TRIANGLE_STRIP,S=new Set,A=[],R=z(l),w;try{for(R.s();!(w=R.n()).done;){var F=w.value,D=z(F.attributes),I;try{for(D.s();!(I=D.n()).done;){var C=I.value,k=C.name.startsWith("a_")?C.name:"a_".concat(C.name);S.has(k)||(S.add(k),A.push({name:k,size:C.size,type:C.type}))}}catch(G){D.e(G)}finally{D.f()}}}catch(G){R.e(G)}finally{R.f()}return{VERTICES:4,VERTEX_SHADER_SOURCE:g.vertexShader,FRAGMENT_SHADER_SOURCE:g.fragmentShader,METHOD:_,UNIFORMS:g.uniforms,ATTRIBUTES:[{name:"a_edgeIndex",size:1,type:T},{name:"a_edgeAttrIndex",size:1,type:T},{name:"a_baseFontSize",size:1,type:T},{name:"a_charMetrics",size:4,type:T},{name:"a_charDims",size:4,type:T},{name:"a_texCoords",size:4,type:T},{name:"a_labelParams",size:2,type:T},{name:"a_color",size:4,type:x,normalized:!0}].concat($(f?[{name:"a_borderColor",size:4,type:x,normalized:!0}]:[]),$(A.filter(function(G){return!["a_curvature","curvature"].includes(G.name)}))),CONSTANT_ATTRIBUTES:[{name:"a_quadCorner",size:2,type:T}],CONSTANT_DATA:[[0,0],[1,0],[0,1],[1,1]]}}},{key:"prepareLabelGlyphs",value:function(b,T){if(T.hidden||!T.text){this.labelGlyphCache.delete(b);return}var x=T.text,_=T.fontKey||this.defaultFontKey;this.atlasManager.ensureGlyphs(x,_);var S=[],A=[],R=0,w=z(x),F;try{for(w.s();!(F=w.n()).done;){var D=F.value,I=D.codePointAt(0);if(I===void 0){S.push(void 0),A.push(R);continue}var C=this.atlasManager.getGlyph(I,_);S.push(C),A.push(R),C&&(R+=C.advance)}}catch(k){w.e(k)}finally{w.f()}this.labelGlyphCache.set(b,{glyphs:S,xOffsets:A,totalWidth:R})}},{key:"processCharacter",value:function(b,T,x,_){var S,A,R,w=this.floats,F=this.STRIDE,D=b*F,I=this.labelGlyphCache.get(T.parentKey);if(!I||!I.glyphs[_]){for(var C=0;C<F;C++)w[D+C]=0;return}var k=I.glyphs[_],G=I.xOffsets[_],N=v.labelColor,L=N&&Z(N)==="object"&&"color"in N&&N.color?N.color:T.color,P=xe(L),M=D;w[M++]=T.edgeIndex,w[M++]=(S=(A=this.edgeAttributeTexture)===null||A===void 0?void 0:A.getIndex(T.parentKey))!==null&&S!==void 0?S:0,w[M++]=T.size,w[M++]=G,w[M++]=k.advance,w[M++]=I.totalWidth,w[M++]=fd(T.position),w[M++]=k.atlasWidth,w[M++]=k.atlasHeight,w[M++]=k.bearingX,w[M++]=-k.bearingY,w[M++]=k.atlasX,w[M++]=k.atlasY,w[M++]=k.atlasWidth,w[M++]=k.atlasHeight;var H=(R=v.labelMargin)!==null&&R!==void 0?R:T.margin;if(w[M++]=H,w[M++]=0,w[M++]=P,f&&o){var O;typeof o.color=="string"?O=o.color:O=o.color.color||"#ffffff",w[M++]=xe(O)}var q=new Set,j=z(l),X;try{for(j.s();!(X=j.n()).done;){var Ee=X.value,he=z(Ee.attributes),Le;try{for(he.s();!(Le=he.n()).done;){var nt=Le.value,St=nt.name.startsWith("a_")?nt.name.slice(2):nt.name;if(St!=="curvature"&&!q.has(St)){q.add(St);for(var At=0;At<nt.size;At++)w[M++]=0}}}catch(wt){he.e(wt)}finally{he.f()}}}catch(wt){j.e(wt)}finally{j.f()}}},{key:"processEdgeLabel",value:function(b,T,x){if(this.prepareLabelGlyphs(b,x),this.edgeAttributeTexture&&!x.hidden&&x.text){this.edgeAttributeTexture.allocate(b);var _=this.packedAttributeData;Pn(this.attrDescriptors,x.edgeAttributes,_,"",cd,0),this.edgeAttributeTexture.updateAllAttributes(b,_)}return se(v,"processLabel",this,3)([b,T,x])}},{key:"updateAtlasTexture",value:function(){if(this.atlasNeedsUpdate){var b=this.normalProgram.gl,T=this.atlasManager.getTextures();if(T.length!==0){var x=T[0];b.bindTexture(b.TEXTURE_2D,this.atlasTexture),b.texImage2D(b.TEXTURE_2D,0,b.RGBA,x.width,x.height,0,b.RGBA,b.UNSIGNED_BYTE,x.data),b.bindTexture(b.TEXTURE_2D,null),this.atlasNeedsUpdate=!1}}}},{key:"setUniforms",value:function(b,T){var x=T.gl,_=T.uniformLocations,S=this.atlasManager.getTextures(),A=S.length>0?[S[0].width,S[0].height]:[1,1];if(x.uniformMatrix3fv(_.u_matrix,!1,b.matrix),x.uniform1f(_.u_sizeRatio,b.sizeRatio),x.uniform1f(_.u_correctionRatio,b.correctionRatio),x.uniform1f(_.u_pixelRatio,b.pixelRatio),x.uniform1f(_.u_cameraAngle,b.cameraAngle),x.uniform1f(_.u_sdfBufferPixels,we.buffer),x.uniform2f(_.u_resolution,b.width,b.height),x.uniform2f(_.u_atlasSize,A[0],A[1]),x.uniform1f(_.u_gamma,this.gamma),x.uniform1f(_.u_sdfBuffer,this.sdfBuffer),x.activeTexture(x.TEXTURE0),x.bindTexture(x.TEXTURE_2D,this.atlasTexture),x.uniform1i(_.u_atlas,0),_.u_nodeDataTexture!==void 0&&x.uniform1i(_.u_nodeDataTexture,b.nodeDataTextureUnit),_.u_nodeDataTextureWidth!==void 0&&x.uniform1i(_.u_nodeDataTextureWidth,b.nodeDataTextureWidth),_.u_edgeDataTexture!==void 0&&x.uniform1i(_.u_edgeDataTexture,b.edgeDataTextureUnit),_.u_edgeDataTextureWidth!==void 0&&x.uniform1i(_.u_edgeDataTextureWidth,b.edgeDataTextureWidth),_.u_edgeFrameTexture!==void 0&&x.uniform1i(_.u_edgeFrameTexture,b.edgeFrameTextureUnit),_.u_edgeFrameTextureWidth!==void 0&&x.uniform1i(_.u_edgeFrameTextureWidth,b.edgeFrameTextureWidth),f&&o&&_.u_borderWidth!==void 0){var R=o.width/we.buffer*this.sdfBuffer;x.uniform1f(_.u_borderWidth,R)}if(this.edgeAttributeTexture&&_.u_edgeAttributeTexture!==void 0&&(this.edgeAttributeTexture.bind(Ue),x.uniform1i(_.u_edgeAttributeTexture,Ue),x.uniform1i(_.u_edgeAttributeTextureWidth,this.edgeAttributeTexture.getTextureWidth()),x.uniform1i(_.u_edgeAttributeTexelsPerEdge,this.edgeAttributeTexture.getTexelsPerItem())),u==="scaled"&&_.u_zoomSizeRatio!==void 0){var w=this.renderer.getSetting("zoomToSizeRatioFunction"),F=1/w(b.zoomRatio);x.uniform1f(_.u_zoomSizeRatio,F)}}},{key:"renderProgram",value:function(b,T){this.updateAtlasTexture(),this.atlasManager.hasPendingGlyphs()&&(this.atlasManager.flush(),this.updateAtlasTexture()),this.edgeAttributeTexture&&this.edgeAttributeTexture.upload(),se(v,"renderProgram",this,3)([b,T])}},{key:"registerFont",value:function(b){var T=arguments.length>1&&arguments[1]!==void 0?arguments[1]:"normal",x=arguments.length>2&&arguments[2]!==void 0?arguments[2]:"normal";return this.atlasManager.registerFont({family:b,weight:T,style:x})}},{key:"getAtlasManager",value:function(){return this.atlasManager}},{key:"ensureGlyphsReady",value:function(b,T){var x=T||this.defaultFontKey,_=z(b),S;try{for(_.s();!(S=_.n()).done;){var A=S.value;this.atlasManager.ensureGlyphs(A,x)}}catch(R){_.e(R)}finally{_.f()}this.atlasManager.flush()}},{key:"measureLabelAtlasWidth",value:function(b,T){var x=T||this.defaultFontKey;this.atlasManager.ensureGlyphs(b,x),this.atlasManager.hasPendingGlyphs()&&this.atlasManager.flush();var _=0,S=z(b),A;try{for(S.s();!(A=S.n()).done;){var R=A.value,w=R.codePointAt(0);if(w!==void 0){var F=this.atlasManager.getGlyph(w,x);F&&(_+=F.advance)}}}catch(D){S.e(D)}finally{S.f()}return _}},{key:"measureLabel",value:function(b,T,x){var _=this.measureLabelAtlasWidth(b,x),S=T/we.fontSize;return{width:_*S,height:T,textHeight:T}}},{key:"kill",value:function(){var b=this.normalProgram.gl;this.refreshTimeout!==null&&(clearTimeout(this.refreshTimeout),this.refreshTimeout=null),this.atlasTexture&&(b.deleteTexture(this.atlasTexture),this.atlasTexture=null),this.edgeAttributeTexture&&(this.edgeAttributeTexture.kill(),this.edgeAttributeTexture=null),this.atlasManager.destroy(),this.labelGlyphCache.clear(),se(v,"kill",this,3)([])}}])}(fi);return E(m,"labelColor",r),E(m,"labelMargin",i),new m(n,a,t)}function vd(){var n=`
// No extremity - always returns positive (outside)
float extremity_none(vec2 uv, float lengthRatio, float widthRatio) {
  return 1.0;
}
`;return{name:"none",glsl:n,length:0,widthFactor:1,margin:0,uniforms:[],attributes:[]}}function Ei(n,a,t,e,r,i,o){var s,l,u=yi(e),d=u.paths,h=u.layers,c=u.defaultHead,f=u.defaultTail,g=[vd()].concat($(u.extremities)),m={},p={};d.forEach(function(D,I){return m[D.name]=I}),g.forEach(function(D,I){return p[D.name]=I});var v=(s=p[c])!==null&&s!==void 0?s:0,y=(l=p[f])!==null&&l!==void 0?l:0,b=null,T=Te([].concat($(d),$(h))),x=function(D){function I(C,k,G){var N;Y(this,I),b||(b=ei({paths:d,extremities:g,layers:h,antialias:r})),N=te(this,I,[C,k,G]),E(N,"layerLifecycles",new Map),E(N,"needsShaderRegeneration",!1),E(N,"edgeAttributeTexture",null),E(N,"layout",T),E(N,"attrDescriptors",[]),E(N,"lifecycleIndexOffset",d.length),N._pickingBuffer=k,N.edgeAttributeTexture=new Ln(C,N.layout),N.packedAttributeData=new Float32Array(N.layout.floatsPerItem),h.forEach(function(P,M){if(P.lifecycle){var H={gl:C,renderer:{refresh:function(){return G.refresh()}},getUniformLocation:function(q){return C.getUniformLocation(N.normalProgram.program,q)},requestShaderRegeneration:function(){N.needsShaderRegeneration=!0},requestRefresh:function(){G.refresh()}};N.layerLifecycles.set(M,P.lifecycle(H))}}),N.layerLifecycles.forEach(function(P){var M;return(M=P.init)===null||M===void 0?void 0:M.call(P)});var L=new Map;return N.layerLifecycles.forEach(function(P,M){P.getAttributeData&&L.set(d.length+M,P)}),N.attrDescriptors=kn([].concat($(d),$(h)),N.layout,L),N}return ne(I,D),K(I,[{key:"getAttributeTexture",value:function(){return this.edgeAttributeTexture}},{key:"resolveEdgeIds",value:function(k,G,N){var L=k,P=0,M=v,H=y,O=G?L.selfLoopPath:N&&L.parallelPath?L.parallelPath:L.path;O&&m[O]!==void 0&&(P=m[O]),L.head&&L.head!=="none"&&p[L.head]!==void 0&&(M=p[L.head]),L.tail&&L.tail!=="none"&&p[L.tail]!==void 0&&(H=p[L.tail]);var q=g[M],j=g[H];return{pathId:P,headId:M,tailId:H,headLengthRatio:Fe(q.length)?0:q.length,tailLengthRatio:Fe(j.length)?0:j.length}}},{key:"getDefinition",value:function(){var k=WebGL2RenderingContext,G=k.TRIANGLE_STRIP,N=G,L=b;return{VERTICES:L.verticesPerEdge,VERTEX_SHADER_SOURCE:L.vertexShader,FRAGMENT_SHADER_SOURCE:L.fragmentShader,METHOD:N,UNIFORMS:L.uniforms,ATTRIBUTES:L.attributes,CONSTANT_ATTRIBUTES:L.constantAttributes,CONSTANT_DATA:L.constantData}}},{key:"maybeRegenerateShaders",value:function(){var k=this;if(this.needsShaderRegeneration){this.needsShaderRegeneration=!1;var G=h.map(function(q,j){var X=k.layerLifecycles.get(j);return X!=null&&X.regenerate?X.regenerate():q});b=ei({paths:d,extremities:g,layers:G,antialias:this.renderer.getSetting("antialiasEdges")});var N=this.normalProgram.gl,L=this.normalProgram,P=L.program,M=L.buffer,H=L.vertexShader,O=L.fragmentShader;N.deleteProgram(P),N.deleteBuffer(M),N.deleteShader(H),N.deleteShader(O),this.normalProgram=this.getProgramInfo("normal",N,b.vertexShader,b.fragmentShader,this._pickingBuffer)}}},{key:"process",value:function(k,G,N,L,P,M){var H=G*this.STRIDE;if(P.visibility==="hidden"||N.visibility==="hidden"||L.visibility==="hidden"){for(var O=H+this.STRIDE;H<O;H++)this.floats[H]=0;this.floats[G*this.STRIDE]=di;return}this.processVisibleItem(dt(k),H,N,L,P,M)}},{key:"processVisibleItem",value:function(k,G,N,L,P,M){var H,O=this.floats,q=this.ints;O[G++]=M,O[G++]=xe(P.color),q[G++]=k,O[G++]=(H=P.opacity)!==null&&H!==void 0?H:1;var j=this.packedAttributeData;Pn(this.attrDescriptors,P,j,P.color,this.layerLifecycles,this.lifecycleIndexOffset),this.edgeAttributeTexture.updateAllAttributesAtRow(M,j)}},{key:"setUniforms",value:function(k,G){var N=this,L=G.gl,P=G.uniformLocations;P.u_matrix&&L.uniformMatrix3fv(P.u_matrix,!1,k.matrix),P.u_sizeRatio&&L.uniform1f(P.u_sizeRatio,k.sizeRatio),P.u_correctionRatio&&L.uniform1f(P.u_correctionRatio,k.correctionRatio),P.u_zoomRatio&&L.uniform1f(P.u_zoomRatio,k.zoomRatio),P.u_pixelRatio&&L.uniform1f(P.u_pixelRatio,k.pixelRatio),P.u_cameraAngle&&L.uniform1f(P.u_cameraAngle,k.cameraAngle),P.u_feather&&L.uniform1f(P.u_feather,k.antiAliasingFeather),P.u_minEdgeThickness&&L.uniform1f(P.u_minEdgeThickness,k.minEdgeThickness),P.u_pickingPadding&&L.uniform1f(P.u_pickingPadding,k.edgePickingPadding),P.u_nodeDataTexture&&L.uniform1i(P.u_nodeDataTexture,k.nodeDataTextureUnit),P.u_nodeDataTextureWidth&&L.uniform1i(P.u_nodeDataTextureWidth,k.nodeDataTextureWidth),P.u_edgeDataTexture&&L.uniform1i(P.u_edgeDataTexture,k.edgeDataTextureUnit),P.u_edgeDataTextureWidth&&L.uniform1i(P.u_edgeDataTextureWidth,k.edgeDataTextureWidth),P.u_edgeFrameTexture&&L.uniform1i(P.u_edgeFrameTexture,k.edgeFrameTextureUnit),P.u_edgeFrameTextureWidth&&L.uniform1i(P.u_edgeFrameTextureWidth,k.edgeFrameTextureWidth),this.edgeAttributeTexture&&this.layout.floatsPerItem>0&&(this.edgeAttributeTexture.bind(Ue),P.u_edgeAttributeTexture&&L.uniform1i(P.u_edgeAttributeTexture,Ue),P.u_edgeAttributeTextureWidth&&L.uniform1i(P.u_edgeAttributeTextureWidth,this.edgeAttributeTexture.getTextureWidth()),P.u_edgeAttributeTexelsPerEdge&&L.uniform1i(P.u_edgeAttributeTexelsPerEdge,this.edgeAttributeTexture.getTexelsPerItem()));var M=new Set;d.forEach(function(H){H.uniforms.forEach(function(O){M.has(O.name)||(M.add(O.name),N.setTypedUniform(O,G))})}),g.forEach(function(H){H.uniforms.forEach(function(O){M.has(O.name)||(M.add(O.name),N.setTypedUniform(O,G))})}),h.forEach(function(H){H.uniforms.forEach(function(O){M.has(O.name)||(M.add(O.name),N.setTypedUniform(O,G))})})}},{key:"render",value:function(k,G,N){this.maybeRegenerateShaders(),se(I,"render",this,3)([k,G,N])}},{key:"renderProgram",value:function(k,G){this.layerLifecycles.forEach(function(N){var L;return(L=N.beforeRender)===null||L===void 0?void 0:L.call(N)}),se(I,"renderProgram",this,3)([k,G])}},{key:"uploadAttributeTexture",value:function(){this.edgeAttributeTexture&&this.layout.floatsPerItem>0&&this.edgeAttributeTexture.upload()}},{key:"kill",value:function(){this.layerLifecycles.forEach(function(k){var G;return(G=k.kill)===null||G===void 0?void 0:G.call(k)}),this.edgeAttributeTexture&&(this.edgeAttributeTexture.kill(),this.edgeAttributeTexture=null),se(I,"kill",this,3)([])}}])}(Ze),_=g[v],S=g[y],A=W({paths:d,headLengthRatio:Fe(_.length)?0:_.length,tailLengthRatio:Fe(S.length)?0:S.length},e.label),R=Ti(A),w=function(){return{labelProgram:gd(n,null,t,A),labelBackgroundProgram:id(n,a,t,{shaderConfig:R})}},F=new Ku(n,{paths:d,extremities:g,layers:h,nodeShapes:i,nodeLayers:o});return{edgeProgram:new x(n,null,t),createLabelPrograms:w,framePass:F}}function pd(n){return Z(n)==="object"&&"uniforms"in n&&Array.isArray(n.uniforms)}function md(n){return Z(n)==="object"&&"uniforms"in n&&"attributes"in n&&"glsl"in n}function yd(n){return Z(n)==="object"&&"uniforms"in n&&"attributes"in n&&"segments"in n}function bd(n){return Z(n)==="object"&&"uniforms"in n&&"attributes"in n&&"length"in n}function xd(n){return Z(n)==="object"&&"uniforms"in n&&"attributes"in n&&"glsl"in n}function _d(n){return Z(n)==="object"&&"glsl"in n&&"name"in n&&!("uniforms"in n)}function Td(n){return Z(n)==="object"&&"glsl"in n&&"name"in n&&!("uniforms"in n)}function Ed(n){return Z(n)==="object"&&"glsl"in n&&"name"in n&&!("uniforms"in n)}function Sd(n){if(pd(n))return n;if(_d(n))return{name:n.name,glsl:n.glsl,inradiusFactor:n.inradiusFactor,uniforms:[]};throw new Error("Invalid node shape specification: ".concat(JSON.stringify(n)))}function Ad(n){if(md(n))return n;if(Ar(n))return{name:n.name,glsl:n.glsl,uniforms:[],attributes:[]};throw new Error("Invalid node layer specification: ".concat(JSON.stringify(n)))}function wd(n){if(yd(n))return n;if(Td(n))return{name:n.name,glsl:n.glsl,segments:n.segments,uniforms:[],attributes:[]};throw new Error("Invalid edge path specification: ".concat(JSON.stringify(n)))}function Dd(n){if(xd(n))return n;if(wr(n))return{name:n.name,glsl:n.glsl,uniforms:[],attributes:[]};throw new Error("Invalid edge layer specification: ".concat(JSON.stringify(n)))}function Rd(n){if(bd(n))return n;if(Ed(n))return{name:n.name,glsl:n.glsl,length:n.length,widthFactor:n.widthFactor,margin:0,uniforms:[],attributes:[]};throw new Error("Invalid edge extremity specification: ".concat(JSON.stringify(n)))}function Si(n){var a,t,e=(a=n?.shapes)!==null&&a!==void 0?a:Ft.shapes,r=(t=n?.layers)!==null&&t!==void 0?t:Ft.layers,i=e.map(Sd),o=r.map(Ad);if(i.length===0)throw new Error("At least one node shape must be specified.");if(o.length===0)throw new Error("At least one node layer must be specified.");return{shapes:i,layers:o}}function Cd(n){var a,t,e,r=(a=n?.paths)!==null&&a!==void 0?a:ht.paths,i=(t=n?.extremities)!==null&&t!==void 0?t:ht.extremities,o=(e=n?.layers)!==null&&e!==void 0?e:ht.layers,s=r.map(wd),l=i.map(Rd).filter(function(d){return d!==null}),u=o.map(Dd);if(s.length===0)throw new Error("At least one edge path must be specified.");if(u.length===0)throw new Error("At least one edge layer must be specified.");return{paths:s,extremities:l,layers:u}}function Ai(n,a){var t={},e=z(n),r;try{for(e.s();!(r=e.n()).done;){var i=r.value;i.variables&&Object.assign(t,i.variables)}}catch(o){e.e(o)}finally{e.f()}return Object.assign(t,a||{}),t}function wi(n,a,t,e,r){var i=Si(e),o=i.shapes,s=i.layers,l=Ai(o,e?.variables),u=vi(n,a,t,{shapes:o,layers:s,label:e?.label,backdrop:e?.backdrop,labelAttachments:e?.labelAttachments},r);return W(W({},u),{},{variables:l})}function Di(n,a,t,e,r,i){var o=Cd(e),s=o.paths,l=o.extremities,u=o.layers,d=Si(i),h=d.shapes,c=d.layers,f=Ai(s,e?.variables),g=Ei(n,a,t,{paths:s,extremities:l,layers:u,defaultHead:e?.defaultHead,defaultTail:e?.defaultTail,label:e?.label},r,h,c);return W(W({},g),{},{variables:f,paths:s})}var Ld=2;function Ri(n,a,t){var e=arguments.length>3&&arguments[3]!==void 0?arguments[3]:Ld,r=a.canvas,i=r.width,o=r.height,s=t.x,l=t.y,u=t.rowHeight,d=t.maxRowWidth,h={},c=[],f=z(n),g;try{for(f.s();!(g=f.n()).done;){var m=g.value,p=m.width+e,v=m.height+e;if(p>i||v>o||s+p>i&&l+u+v>o){c.push(m);continue}s+p>i&&(d=Math.max(d,s),s=0,l+=u,u=v),m.draw(a,s,l),h[m.key]={x:s,y:l,width:m.width,height:m.height},s+=p,u=Math.max(u,v)}}catch(y){f.e(y)}finally{f.f()}return d=Math.max(d,s),{atlas:h,cursor:{x:s,y:l,rowHeight:u,maxRowWidth:d},remaining:c}}function ce(n,a,t,e){var r=Object.defineProperty;try{r({},"",{})}catch{r=0}ce=function(i,o,s,l){function u(d,h){ce(i,d,function(c){return this._invoke(d,h,c)})}o?r?r(i,o,{value:s,enumerable:!l,configurable:!l,writable:!l}):i[o]=s:(u("next",0),u("throw",1),u("return",2))},ce(n,a,t,e)}function fe(){var n,a,t=typeof Symbol=="function"?Symbol:{},e=t.iterator||"@@iterator",r=t.toStringTag||"@@toStringTag";function i(f,g,m,p){var v=g&&g.prototype instanceof s?g:s,y=Object.create(v.prototype);return ce(y,"_invoke",function(b,T,x){var _,S,A,R=0,w=x||[],F=!1,D={p:0,n:0,v:n,a:I,f:I.bind(n,4),d:function(C,k){return _=C,S=0,A=n,D.n=k,o}};function I(C,k){for(S=C,A=k,a=0;!F&&R&&!G&&a<w.length;a++){var G,N=w[a],L=D.p,P=N[2];C>3?(G=P===k)&&(A=N[(S=N[4])?5:(S=3,3)],N[4]=N[5]=n):N[0]<=L&&((G=C<2&&L<N[1])?(S=0,D.v=k,D.n=N[1]):L<P&&(G=C<3||N[0]>k||k>P)&&(N[4]=C,N[5]=k,D.n=P,S=0))}if(G||C>1)return o;throw F=!0,k}return function(C,k,G){if(R>1)throw TypeError("Generator is already running");for(F&&k===1&&I(k,G),S=k,A=G;(a=S<2?n:A)||!F;){_||(S?S<3?(S>1&&(D.n=-1),I(S,A)):D.n=A:D.v=A);try{if(R=2,_){if(S||(C="next"),a=_[C]){if(!(a=a.call(_,A)))throw TypeError("iterator result is not an object");if(!a.done)return a;A=a.value,S<2&&(S=0)}else S===1&&(a=_.return)&&a.call(_),S<2&&(A=TypeError("The iterator does not provide a '"+C+"' method"),S=1);_=n}else if((a=(F=D.n<0)?A:b.call(T,D))!==o)break}catch(N){_=n,S=1,A=N}finally{R=1}}return{value:a,done:F}}}(f,m,p),!0),y}var o={};function s(){}function l(){}function u(){}a=Object.getPrototypeOf;var d=[][e]?a(a([][e]())):(ce(a={},e,function(){return this}),a),h=u.prototype=s.prototype=Object.create(d);function c(f){return Object.setPrototypeOf?Object.setPrototypeOf(f,u):(f.__proto__=u,ce(f,r,"GeneratorFunction")),f.prototype=Object.create(h),f}return l.prototype=u,ce(h,"constructor",u),ce(u,"constructor",l),l.displayName="GeneratorFunction",ce(u,r,"GeneratorFunction"),ce(h),ce(h,r,"Generator"),ce(h,e,function(){return this}),ce(h,"toString",function(){return"[object Generator]"}),(fe=function(){return{w:i,m:c}})()}function Ci(n,a,t,e,r,i,o){try{var s=n[i](o),l=s.value}catch(u){return void t(u)}s.done?a(l):Promise.resolve(l).then(e,r)}function _t(n){return function(){var a=this,t=arguments;return new Promise(function(e,r){var i=n.apply(a,t);function o(l){Ci(i,e,r,o,s,"next",l)}function s(l){Ci(i,e,r,o,s,"throw",l)}o(void 0)})}}var In=new Map,Li=!1;function kd(n){return new Promise(function(a,t){var e=new FileReader;e.onload=function(){return a(e.result)},e.onerror=t,e.readAsDataURL(n)})}function Pd(n){if(!In.has(n)){var a=fetch(n).then(function(t){return t.blob()}).then(kd).catch(function(){return In.delete(n),null});In.set(n,a)}return In.get(n)}function Fd(n){return Ea.apply(this,arguments)}function Ea(){return Ea=_t(fe().m(function n(a){var t,e,r;return fe().w(function(i){for(;;)switch(i.n){case 0:return t=document.createElement("div"),t.innerHTML=a,e=Array.from(t.querySelectorAll("img[src]")),r=e.filter(function(o){return!o.getAttribute("src").startsWith("data:")}),i.n=1,Promise.all(r.map(function(){var o=_t(fe().m(function s(l){var u;return fe().w(function(d){for(;;)switch(d.n){case 0:return d.n=1,Pd(l.getAttribute("src"));case 1:u=d.v,u&&l.setAttribute("src",u);case 2:return d.a(2)}},s)}));return function(s){return o.apply(this,arguments)}}()));case 1:return i.a(2,t.innerHTML)}},n)})),Ea.apply(this,arguments)}function ki(n){return Sa.apply(this,arguments)}function Sa(){return Sa=_t(fe().m(function n(a){var t,e,r,i,o,s,l,u,d,h,c,f,g,m=arguments;return fe().w(function(p){for(;;)switch(p.n){case 0:if(t=m.length>1&&m[1]!==void 0?m[1]:1,e=a instanceof SVGElement?new XMLSerializer().serializeToString(a):a,r=new DOMParser,i=r.parseFromString(e,"image/svg+xml"),o=i.querySelector("svg"),o){p.n=1;break}return p.a(2,null);case 1:if(s=parseFloat(o.getAttribute("width")||""),l=parseFloat(o.getAttribute("height")||""),(!(s>0)||!(l>0))&&(u=o.getAttribute("viewBox"),u&&(d=u.trim().split(/[\s,]+/),s=parseFloat(d[2]),l=parseFloat(d[3]))),!(!(s>0)||!(l>0))){p.n=2;break}return console.warn("Sigma: SVG label attachment has no parseable dimensions \u2014 skipped."),p.a(2,null);case 2:return h=Math.ceil(s*t),c=Math.ceil(l*t),f=new Blob([e],{type:"image/svg+xml"}),g=URL.createObjectURL(f),p.a(2,new Promise(function(v){var y=new Image;y.onload=function(){var b=document.createElement("canvas");b.width=h,b.height=c,b.getContext("2d").drawImage(y,0,0,h,c),URL.revokeObjectURL(g);try{b.getContext("2d").getImageData(0,0,1,1)}catch(T){if(T instanceof DOMException&&T.name==="SecurityError"){Li||(Li=!0,console.warn('Sigma: A label attachment was skipped because the rendered canvas is tainted. SVG with <foreignObject> (used by the "html" attachment type) is blocked in Chromium and Safari. Use type: "canvas" with Canvas 2D rendering instead.')),v(null);return}throw T}v(b)},y.onerror=function(){URL.revokeObjectURL(g),v(null)},y.src=g}))}},n)})),Sa.apply(this,arguments)}function Id(n,a){var t=document.createElement("div");t.style.cssText="position:fixed;left:-99999px;top:0;visibility:hidden;width:max-content;height:max-content",t.innerHTML=(a?"<style>".concat(a,"</style>"):"")+n,document.body.appendChild(t);var e=t.getBoundingClientRect(),r=e.width,i=e.height;return document.body.removeChild(t),{width:Math.ceil(r),height:Math.ceil(i)}}function Nd(n,a,t,e){return Aa.apply(this,arguments)}function Aa(){return Aa=_t(fe().m(function n(a,t,e,r){var i,o,s,l,u,d,h,c,f=arguments;return fe().w(function(g){for(;;)switch(g.n){case 0:return i=f.length>4&&f[4]!==void 0?f[4]:1,o=a instanceof HTMLElement?a.outerHTML:a,g.n=1,Fd(o);case 1:return s=g.v,(e==null||r==null)&&(l=Id(s,t),e=e??l.width,r=r??l.height),u=Math.ceil(e*i),d=Math.ceil(r*i),h=t?"<style>".concat(t,"</style>"):"",c='<svg xmlns="http://www.w3.org/2000/svg" '+'width="'.concat(u,'" height="').concat(d,'" viewBox="0 0 ').concat(e," ").concat(r,'">')+'<foreignObject width="'.concat(e,'" height="').concat(r,'">')+'<body xmlns="http://www.w3.org/1999/xhtml" style="margin:0;padding:0">'.concat(h).concat(s,"</body>")+"</foreignObject></svg>",g.a(2,ki(c,1))}},n)})),Aa.apply(this,arguments)}function Gd(n){return wa.apply(this,arguments)}function wa(){return wa=_t(fe().m(function n(a){var t,e=arguments,r;return fe().w(function(i){for(;;)switch(i.n){case 0:t=e.length>1&&e[1]!==void 0?e[1]:1,r=a.type,i.n=r==="canvas"?1:r==="svg"?2:r==="html"?3:4;break;case 1:return i.a(2,a.canvas);case 2:return i.a(2,ki(a.svg,t));case 3:return i.a(2,Nd(a.html,a.css,a.width,a.height,t));case 4:return i.a(2)}},n)})),wa.apply(this,arguments)}var xt=2048,Pi=function(){function n(a,t,e){Y(this,n),E(this,"cache",new Map),E(this,"pending",new Set),E(this,"atlas",{}),E(this,"glTexture",null),E(this,"dirty",!0),this.gl=a,this.renderers=t,this.scheduleRender=e,this.packCanvas=document.createElement("canvas"),this.packCanvas.width=xt,this.packCanvas.height=xt,this.packCtx=this.packCanvas.getContext("2d")}return K(n,[{key:"renderAttachment",value:function(t,e,r){var i=this,o="".concat(t,":").concat(e);if(!(this.cache.has(o)||this.pending.has(o))){var s=this.renderers[e];if(s){var l=s(r);if(l){this.pending.add(o);var u=r.pixelRatio;Promise.resolve(l).then(function(){var d=_t(fe().m(function h(c){var f;return fe().w(function(g){for(;;)switch(g.n){case 0:if(i.pending.has(o)){g.n=1;break}return g.a(2);case 1:if(i.pending.delete(o),c){g.n=2;break}return g.a(2);case 2:return g.n=3,Gd(c,u);case 3:if(f=g.v,!(!f||f.width===0||f.height===0)){g.n=4;break}return g.a(2);case 4:i.cache.set(o,{image:f,width:f.width,height:f.height}),i.dirty=!0,i.scheduleRender();case 5:return g.a(2)}},h)}));return function(h){return d.apply(this,arguments)}}())}}}}},{key:"regenerateAtlas",value:function(){if(this.dirty){this.dirty=!1;var t=[];if(this.cache.forEach(function(u,d){t.push({key:d,width:u.width,height:u.height,draw:function(c,f,g){c.drawImage(u.image,f,g)}})}),t.length===0){this.atlas={},this.deleteGLTexture();return}var e={x:0,y:0,rowHeight:0,maxRowWidth:0};this.packCtx.clearRect(0,0,xt,xt);var r=Ri(t,this.packCtx,e),i=r.atlas,o=r.remaining;this.atlas=i,o.length>0&&console.warn("Sigma: ".concat(o.length," label attachment(s) could not fit in the ").concat(xt,"x").concat(xt," atlas and will not be rendered.")),this.deleteGLTexture();var s=this.gl,l=s.createTexture();s.activeTexture(s.TEXTURE0+Ot),s.bindTexture(s.TEXTURE_2D,l),s.pixelStorei(s.UNPACK_PREMULTIPLY_ALPHA_WEBGL,!0),s.texImage2D(s.TEXTURE_2D,0,s.RGBA,s.RGBA,s.UNSIGNED_BYTE,this.packCanvas),s.pixelStorei(s.UNPACK_PREMULTIPLY_ALPHA_WEBGL,!1),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MIN_FILTER,s.LINEAR),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MAG_FILTER,s.LINEAR),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_WRAP_S,s.CLAMP_TO_EDGE),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_WRAP_T,s.CLAMP_TO_EDGE),this.glTexture=l}}},{key:"bindTexture",value:function(t){if(this.glTexture){var e=this.gl;e.activeTexture(e.TEXTURE0+t),e.bindTexture(e.TEXTURE_2D,this.glTexture)}}},{key:"getEntry",value:function(t,e){var r="".concat(t,":").concat(e);return this.atlas[r]||null}},{key:"invalidateNode",value:function(t){var e="".concat(t,":"),r=z(this.cache.keys()),i;try{for(r.s();!(i=r.n()).done;){var o=i.value;o.startsWith(e)&&(this.cache.delete(o),this.dirty=!0)}}catch(d){r.e(d)}finally{r.f()}var s=z(this.pending),l;try{for(s.s();!(l=s.n()).done;){var u=l.value;u.startsWith(e)&&this.pending.delete(u)}}catch(d){s.e(d)}finally{s.f()}}},{key:"restore",value:function(){this.glTexture=null,this.dirty=!0}},{key:"clear",value:function(){this.cache.clear(),this.pending.clear(),this.atlas={},this.dirty=!0,this.deleteGLTexture()}},{key:"kill",value:function(){this.clear(),this.packCanvas=null,this.packCtx=null,this.gl=null}},{key:"deleteGLTexture",value:function(){this.glTexture&&(this.gl.deleteTexture(this.glTexture),this.glTexture=null)}}])}(),Da=function(){function n(a){Y(this,n),E(this,"buckets",new Map),E(this,"keyDepth",new Map);var t=z(a),e;try{for(t.s();!(e=t.n()).done;){var r=e.value;this.buckets.set(r,new Set)}}catch(i){t.e(i)}finally{t.f()}}return K(n,[{key:"has",value:function(t){return this.keyDepth.has(t)}},{key:"getBucket",value:function(t){return this.buckets.get(t)}},{key:"set",value:function(t,e){var r,i=this.keyDepth.get(t);if(i!==e){var o=this.buckets.get(e);if(!o)throw new Error('Sigma: "'.concat(e,'" is not a declared depth layer'));i!==void 0&&((r=this.buckets.get(i))===null||r===void 0||r.delete(t)),o.add(t),this.keyDepth.set(t,e)}}},{key:"remove",value:function(t){var e=this.keyDepth.get(t);e!==void 0&&(this.buckets.get(e).delete(t),this.keyDepth.delete(t))}},{key:"clearAll",value:function(){var t=z(this.buckets.values()),e;try{for(t.s();!(e=t.n()).done;){var r=e.value;r.clear()}}catch(i){t.e(i)}finally{t.f()}this.keyDepth.clear()}},{key:"getSorted",value:function(t,e){var r=this.buckets.get(t);return!r||r.size===0?[]:$(r).sort(function(i,o){return e(i)-e(o)})}}])}(),Fi=function(n){function a(t,e){return Y(this,a),te(this,a,[t,2,e])}return ne(a,n),K(a,[{key:"updateNode",value:function(e,r,i,o,s,l,u,d){var h=this.indexMap.get(e);if(h===void 0)throw new Error('Node "'.concat(e,'" not allocated in NodeDataTexture'));var c=ze(d),f=Q(c,4),g=f[0],m=f[1],p=f[2],v=f[3],y=h*2*4;this.data[y]=r,this.data[y+1]=i,this.data[y+2]=o,this.data[y+3]=s,this.data[y+4]=l,this.data[y+5]=u,this.data[y+6]=g*65536+m*256+p,this.data[y+7]=v/255,this.markDirty(h)}}])}(Cn),Md=1024,zd=1.5,Wd=4096,Ra=function(){function n(a,t){var e;if(Y(this,n),E(this,"texture",null),E(this,"framebuffer",null),!a.getExtension("EXT_color_buffer_float"))throw new Error("sigma: EXT_color_buffer_float is required for label/edge placement but is unavailable in this WebGL2 context.");this.gl=a,this.channels=t.channels,this.capacity=this.roundUpToPowerOfTwo((e=t.initialCapacity)!==null&&e!==void 0?e:Md);var r=this.computeDimensions(this.capacity);this.textureWidth=r.width,this.textureHeight=r.height,this.create()}return K(n,[{key:"roundUpToPowerOfTwo",value:function(t){return Math.pow(2,Math.ceil(Math.log2(Math.max(1,t))))}},{key:"computeDimensions",value:function(t){var e=Math.min(t,Wd),r=Math.ceil(t/e);return{width:e,height:r}}},{key:"create",value:function(){var t=this.gl,e=this.channels===1?t.R32F:t.RGBA32F,r=this.channels===1?t.RED:t.RGBA;if(this.texture=t.createTexture(),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_2D,this.texture),t.texImage2D(t.TEXTURE_2D,0,e,this.textureWidth,this.textureHeight,0,r,t.FLOAT,null),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.NEAREST),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.NEAREST),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),this.framebuffer=t.createFramebuffer(),t.bindFramebuffer(t.FRAMEBUFFER,this.framebuffer),t.framebufferTexture2D(t.FRAMEBUFFER,t.COLOR_ATTACHMENT0,t.TEXTURE_2D,this.texture,0),t.checkFramebufferStatus(t.FRAMEBUFFER)!==t.FRAMEBUFFER_COMPLETE)throw new Error("sigma: float framebuffer for frame-pass placement is incomplete.");t.bindFramebuffer(t.FRAMEBUFFER,null),t.bindTexture(t.TEXTURE_2D,null)}},{key:"ensureCapacity",value:function(t){if(!(t<=this.capacity)){var e=this.gl;this.capacity=this.roundUpToPowerOfTwo(Math.ceil(t*zd));var r=this.computeDimensions(this.capacity);this.textureWidth=r.width,this.textureHeight=r.height,this.texture&&e.deleteTexture(this.texture),this.framebuffer&&e.deleteFramebuffer(this.framebuffer),this.create()}}},{key:"bindAsRenderTarget",value:function(){var t=this.gl;t.bindFramebuffer(t.FRAMEBUFFER,this.framebuffer),t.viewport(0,0,this.textureWidth,this.textureHeight)}},{key:"bind",value:function(t){var e=this.gl;e.activeTexture(e.TEXTURE0+t),e.bindTexture(e.TEXTURE_2D,this.texture)}},{key:"getTexture",value:function(){return this.texture}},{key:"getTextureWidth",value:function(){return this.textureWidth}},{key:"getTextureHeight",value:function(){return this.textureHeight}},{key:"restore",value:function(){this.gl.getExtension("EXT_color_buffer_float"),this.create()}},{key:"kill",value:function(){var t=this.gl;this.texture&&(t.deleteTexture(this.texture),this.texture=null),this.framebuffer&&(t.deleteFramebuffer(this.framebuffer),this.framebuffer=null)}}])}(),Ii=function(n){function a(t,e){return Y(this,a),te(this,a,[t,2,e])}return ne(a,n),K(a,[{key:"updateEdge",value:function(e,r,i,o,s,l){var u=arguments.length>6&&arguments[6]!==void 0?arguments[6]:0,d=arguments.length>7&&arguments[7]!==void 0?arguments[7]:0,h=arguments.length>8&&arguments[8]!==void 0?arguments[8]:0,c=this.indexMap.get(e);if(c===void 0)throw new Error('Edge "'.concat(e,'" not allocated in EdgeDataTexture'));var f=c*this.TEXELS_PER_ITEM*4;this.data[f+0]=r,this.data[f+1]=i,this.data[f+2]=o,this.data[f+3]=0,this.data[f+4]=s,this.data[f+5]=l,this.data[f+6]=u,this.data[f+7]=(d&15)<<4|h&15,this.markDirty(c)}}])}(Cn);var Hc=Ve(Dt()),$c=Ve(It());function Bd(n,a){if(n==null)return{};var t={};for(var e in n)if({}.hasOwnProperty.call(n,e)){if(a.indexOf(e)!==-1)continue;t[e]=n[e]}return t}function Ni(n,a){if(n==null)return{};var t,e,r=Bd(n,a);if(Object.getOwnPropertySymbols){var i=Object.getOwnPropertySymbols(n);for(e=0;e<i.length;e++)t=i[e],a.indexOf(t)===-1&&{}.propertyIsEnumerable.call(n,t)&&(r[t]=n[t])}return r}var Ud=["factor"],Od=["factor"],Gi=1.5,Ca={x:.5,y:.5,angle:0,ratio:1},Mi=function(n){function a(){var t;Y(this,a);for(var e=arguments.length,r=new Array(e),i=0;i<e;i++)r[i]=arguments[i];return t=te(this,a,[].concat(r)),E(t,"minRatio",null),E(t,"maxRatio",null),E(t,"enabled",!0),E(t,"enabledZooming",!0),E(t,"enabledPanning",!0),E(t,"enabledRotation",!0),E(t,"constrainState",null),E(t,"state",W({},Ca)),E(t,"previousState",W({},Ca)),E(t,"nextFrame",null),E(t,"currentAnimationFrom",null),E(t,"currentAnimationTo",null),E(t,"animationCallback",null),t}return ne(a,n),K(a,[{key:"x",get:function(){return this.state.x}},{key:"y",get:function(){return this.state.y}},{key:"angle",get:function(){return this.state.angle}},{key:"ratio",get:function(){return this.state.ratio}},{key:"getState",value:function(){return W({},this.state)}},{key:"getPreviousState",value:function(){return W({},this.previousState)}},{key:"getBoundedRatio",value:function(e){var r=e;return typeof this.minRatio=="number"&&(r=Math.max(r,this.minRatio)),typeof this.maxRatio=="number"&&(r=Math.min(r,this.maxRatio)),r}},{key:"validateState",value:function(e){var r=this.getState();return this.enabledPanning&&typeof e.x=="number"&&(r.x=e.x),this.enabledPanning&&typeof e.y=="number"&&(r.y=e.y),this.enabledZooming&&typeof e.ratio=="number"&&(r.ratio=this.getBoundedRatio(e.ratio)),this.enabledRotation&&typeof e.angle=="number"&&(r.angle=e.angle),this.constrainState?this.constrainState(r):r}},{key:"isAnimating",value:function(){return this.nextFrame!==null}},{key:"setState",value:function(e){if(!this.enabled)return this;var r=this.validateState(e);return Ur(this.state,r)?this:(this.previousState=this.state,this.state=r,this.emit("updated",this.getState()),this)}},{key:"updateState",value:function(e){return this.setState(e(this.getState())),this}},{key:"animate",value:function(e,r){var i=this;return this.enabled?new Promise(function(o){return i.runAnimation(e,W(W({},$r),r),o)}):Promise.resolve()}},{key:"cancelAnimation",value:function(){return this.nextFrame!==null&&(cancelAnimationFrame(this.nextFrame),this.nextFrame=null),this.resolveAnimation(),this.emitAnimationEnd(!1),this}},{key:"zoomIn",value:function(){var e=arguments.length>0&&arguments[0]!==void 0?arguments[0]:{},r=e.factor,i=r===void 0?Gi:r,o=Ni(e,Ud);return this.animate({ratio:this.ratio/i},o)}},{key:"zoomOut",value:function(){var e=arguments.length>0&&arguments[0]!==void 0?arguments[0]:{},r=e.factor,i=r===void 0?Gi:r,o=Ni(e,Od);return this.animate({ratio:this.ratio*i},o)}},{key:"reset",value:function(e){return this.animate(Ca,e)}},{key:"runAnimation",value:function(e,r,i){var o=this,s=cn(r.easing),l=Date.now(),u=this.getState(),d=this.validateState(e),h=function(){if(!o.enabled){o.cancelAnimation();return}var f=r.duration>0?(Date.now()-l)/r.duration:1;if(f>=1){o.nextFrame=null,o.setState(d),o.resolveAnimation(),o.emitAnimationEnd(!0);return}var g=s(f);o.setState({x:u.x+(d.x-u.x)*g,y:u.y+(d.y-u.y)*g,angle:u.angle+(d.angle-u.angle)*g,ratio:u.ratio+(d.ratio-u.ratio)*g}),o.nextFrame=requestAnimationFrame(h)};this.cancelAnimation(),this.currentAnimationFrom=u,this.currentAnimationTo=d,this.animationCallback=i,this.emit("animationStart",{from:u,to:d}),h()}},{key:"resolveAnimation",value:function(){var e=this.animationCallback;this.animationCallback=null,e&&e()}},{key:"emitAnimationEnd",value:function(e){var r=this.currentAnimationFrom,i=this.currentAnimationTo;!r||!i||(this.currentAnimationFrom=null,this.currentAnimationTo=null,this.emit("animationEnd",{from:r,to:i,completed:e}))}}],[{key:"from",value:function(e){var r=new a;return r.setState(e)}}])}(pn);function ge(n,a){var t=a.getBoundingClientRect();return{x:n.clientX-t.left,y:n.clientY-t.top}}function De(n,a){var t=W(W({},ge(n,a)),{},{sigmaDefaultPrevented:!1,preventSigmaDefault:function(){t.sigmaDefaultPrevented=!0},original:n});return t}function Qe(n){var a="x"in n?n:W(W({},n.touches[0]||n.previousTouches[0]),{},{original:n.original,sigmaDefaultPrevented:n.sigmaDefaultPrevented,preventSigmaDefault:function(){n.sigmaDefaultPrevented=!0,a.sigmaDefaultPrevented=!0}});return a}function Hd(n,a){var t=De(n,a);return t.delta=Qi(n),t}var $d=2;function Gn(n){for(var a=[],t=0,e=Math.min(n.length,$d);t<e;t++)a.push(n[t]);return a}function $t(n,a,t){var e={touches:Gn(n.touches).map(function(r){return ge(r,t)}),previousTouches:a.map(function(r){return ge(r,t)}),sigmaDefaultPrevented:!1,preventSigmaDefault:function(){e.sigmaDefaultPrevented=!0},original:n};return e}function Qi(n){if(typeof n.deltaY<"u")return n.deltaY*-3/360;if(typeof n.detail<"u")return n.detail/-9;throw new Error("Captor: could not extract delta from event.")}var Ji=function(n){function a(t,e){var r;return Y(this,a),r=te(this,a),r.container=t,r.renderer=e,r}return ne(a,n),K(a)}(pn),Vd=["doubleClickTimeout","doubleClickZoomingDuration","doubleClickZoomingRatio","dragTimeout","draggedEventsTolerance","enableCameraMouseRotation","gestureTarget","inertiaDuration","inertiaRatio","zoomDuration","zoomingRatio"],jd=Vd.reduce(function(n,a){return W(W({},n),{},E({},a,bn[a]))},{});function Vt(n){return n instanceof PointerEvent&&n.pointerType==="touch"}var Xd=function(n){function a(t,e){var r;return Y(this,a),r=te(this,a,[t,e]),E(r,"enabled",!0),E(r,"draggedEvents",0),E(r,"downStartTime",null),E(r,"lastMouseX",null),E(r,"lastMouseY",null),E(r,"isMouseDown",!1),E(r,"isMoving",!1),E(r,"isPanningStage",!1),E(r,"movingTimeout",null),E(r,"startCameraState",null),E(r,"clicks",0),E(r,"doubleClickTimeout",null),E(r,"isRightMouseDown",!1),E(r,"startRotationAngle",null),E(r,"startCameraAngle",null),E(r,"currentWheelDirection",0),E(r,"lastWheelAnimationId",0),E(r,"settings",jd),r.handleRightClick=r.handleRightClick.bind(r),r.handleDown=r.handleDown.bind(r),r.handleUp=r.handleUp.bind(r),r.handleMove=r.handleMove.bind(r),r.handleWheel=r.handleWheel.bind(r),r.handleLeave=r.handleLeave.bind(r),r.handleEnter=r.handleEnter.bind(r),t.addEventListener("contextmenu",r.handleRightClick,{capture:!1}),t.addEventListener("pointerdown",r.handleDown,{capture:!1}),t.addEventListener("wheel",r.handleWheel,{capture:!1,passive:!1}),t.addEventListener("pointerleave",r.handleLeave,{capture:!1}),t.addEventListener("pointerenter",r.handleEnter,{capture:!1}),document.addEventListener("pointermove",r.handleMove,{capture:!1}),document.addEventListener("pointerup",r.handleUp,{capture:!1}),r}return ne(a,n),K(a,[{key:"kill",value:function(){var e=this.container;e.removeEventListener("contextmenu",this.handleRightClick),e.removeEventListener("pointerdown",this.handleDown),e.removeEventListener("wheel",this.handleWheel),e.removeEventListener("pointerleave",this.handleLeave),e.removeEventListener("pointerenter",this.handleEnter),document.removeEventListener("pointermove",this.handleMove),document.removeEventListener("pointerup",this.handleUp)}},{key:"handleClick",value:function(e){var r=this;if(this.enabled){if(this.clicks++,this.clicks===2)return this.clicks=0,typeof this.doubleClickTimeout=="number"&&(clearTimeout(this.doubleClickTimeout),this.doubleClickTimeout=null),this.handleDoubleClick(e);setTimeout(function(){r.clicks=0,r.doubleClickTimeout=null},this.settings.doubleClickTimeout),this.draggedEvents<this.settings.draggedEventsTolerance&&this.emit("click",De(e,this.container))}}},{key:"handleRightClick",value:function(e){this.enabled&&(this.settings.enableCameraMouseRotation&&e.preventDefault(),this.emit("rightClick",De(e,this.container)))}},{key:"handleDoubleClick",value:function(e){if(this.enabled){e.preventDefault(),e.stopPropagation();var r=De(e,this.container);if(this.emit("doubleClick",r),!r.sigmaDefaultPrevented){var i=this.renderer.getCamera(),o=i.getBoundedRatio(i.getState().ratio/this.settings.doubleClickZoomingRatio);i.animate(this.renderer.getViewportZoomedState(ge(e,this.container),o),{easing:"quadraticInOut",duration:this.settings.doubleClickZoomingDuration})}}}},{key:"handleDown",value:function(e){if(!(!this.enabled||Vt(e))){if(e.button===0){this.startCameraState=this.renderer.getCamera().getState();var r=ge(e,this.container),i=r.x,o=r.y;this.lastMouseX=i,this.lastMouseY=o,this.draggedEvents=0,this.downStartTime=Date.now(),this.isMouseDown=!0}if(e.button===2&&this.settings.enableCameraMouseRotation){var s=ge(e,this.container),l=s.x,u=s.y,d=this.container.offsetWidth/2,h=this.container.offsetHeight/2;this.startRotationAngle=Math.atan2(u-h,l-d),this.startCameraAngle=this.renderer.getCamera().getState().angle,this.isRightMouseDown=!0}this.emit("mousedown",De(e,this.container))}}},{key:"handleUp",value:function(e){var r=this;if(!(!this.enabled||Vt(e)||!this.isMouseDown&&!this.isRightMouseDown)){if(this.isRightMouseDown){this.isRightMouseDown=!1,this.startRotationAngle=null,this.startCameraAngle=null,this.emit("mouseup",De(e,this.container));return}var i=this.renderer.getCamera();this.isMouseDown=!1,this.isPanningStage&&(this.isPanningStage=!1,this.renderer._setPanning(!1)),typeof this.movingTimeout=="number"&&(clearTimeout(this.movingTimeout),this.movingTimeout=null);var o=ge(e,this.container),s=o.x,l=o.y,u=i.getState(),d=i.getPreviousState();this.isMoving?i.animate({x:u.x+this.settings.inertiaRatio*(u.x-d.x),y:u.y+this.settings.inertiaRatio*(u.y-d.y)},{duration:this.settings.inertiaDuration,easing:"quadraticOut"}):(this.lastMouseX!==s||this.lastMouseY!==l)&&i.setState({x:u.x,y:u.y}),this.isMoving=!1,setTimeout(function(){var h=r.draggedEvents>0;r.draggedEvents=0;var c=r.renderer.getSetting("hideEdgesOnMove")||r.renderer.getSetting("hideLabelsOnMove");h&&c&&r.renderer.refresh()},0),this.emit("mouseup",De(e,this.container)),(e.target===this.container||e.composedPath()[0]===this.container)&&this.handleClick(e)}}},{key:"handleMove",value:function(e){var r=this;if(!(!this.enabled||Vt(e))){var i=De(e,this.container);if(this.emit("mousemovebody",i),(e.target===this.container||e.composedPath()[0]===this.container)&&this.emit("mousemove",i),this.isMouseDown&&this.draggedEvents++,!i.sigmaDefaultPrevented){if(this.isMouseDown){this.isMoving=!0,typeof this.movingTimeout=="number"&&clearTimeout(this.movingTimeout),this.movingTimeout=window.setTimeout(function(){r.movingTimeout=null,r.isMoving=!1},this.settings.dragTimeout);var o=this.renderer.getCamera(),s=ge(e,this.container),l=s.x,u=s.y,d=this.renderer.viewportToFramedGraph({x:this.lastMouseX,y:this.lastMouseY}),h=this.renderer.viewportToFramedGraph({x:l,y:u}),c=d.x-h.x,f=d.y-h.y,g=o.getState(),m=g.x+c,p=g.y+f;this.isPanningStage||(this.isPanningStage=!0,this.renderer._setPanning(!0)),o.setState({x:m,y:p}),this.lastMouseX=l,this.lastMouseY=u,e.preventDefault(),e.stopPropagation()}if(this.isRightMouseDown){var v=ge(e,this.container),y=v.x,b=v.y,T=this.container.offsetWidth/2,x=this.container.offsetHeight/2,_=Math.atan2(b-x,y-T),S=_-this.startRotationAngle,A=this.renderer.getCamera();A.setState({angle:this.startCameraAngle+S}),e.preventDefault(),e.stopPropagation()}}}}},{key:"handleLeave",value:function(e){Vt(e)||this.emit("mouseleave",De(e,this.container))}},{key:"handleEnter",value:function(e){Vt(e)||this.emit("mouseenter",De(e,this.container))}},{key:"handleWheel",value:function(e){var r=this,i=this.renderer.getCamera();if(!(!this.enabled||!i.enabledZooming)){var o=Hd(e,this.container);if(this.emit("wheel",o),!o.sigmaDefaultPrevented){var s=this.settings.gestureTarget;if(s!=="page"){if(s==="shared"&&!e.ctrlKey&&!e.metaKey){this.renderer._showGestureHint("wheel");return}var l=Qi(e);if(l){e.preventDefault(),e.stopPropagation();var u=i.getState().ratio,d=l>0?1/this.settings.zoomingRatio:this.settings.zoomingRatio,h=i.getBoundedRatio(u*d),c=l>0?1:-1,f=Date.now();if(u!==h&&!(this.currentWheelDirection===c&&this.lastWheelTriggerTime&&f-this.lastWheelTriggerTime<this.settings.zoomDuration/5)){var g=++this.lastWheelAnimationId;i.animate(this.renderer.getViewportZoomedState(ge(e,this.container),h),{easing:"quadraticOut",duration:this.settings.zoomDuration}).then(function(){r.lastWheelAnimationId===g&&(r.currentWheelDirection=0)}),this.currentWheelDirection=c,this.lastWheelTriggerTime=f}}}}}}},{key:"setSettings",value:function(e){this.settings=e}}])}(Ji),qd=["dragTimeout","gestureTarget","inertiaDuration","inertiaRatio","doubleClickTimeout","doubleClickZoomingRatio","doubleClickZoomingDuration","tapMoveTolerance"],Yd=qd.reduce(function(n,a){return W(W({},n),{},E({},a,bn[a]))},{}),Kd=function(n){function a(t,e){var r;return Y(this,a),r=te(this,a,[t,e]),E(r,"enabled",!0),E(r,"isMoving",!1),E(r,"hasMoved",!1),E(r,"isPanningStage",!1),E(r,"isZoomingStage",!1),E(r,"touchMode",0),E(r,"startTouchesPositions",[]),E(r,"lastTouches",[]),E(r,"lastTap",null),E(r,"settings",Yd),r.handleStart=r.handleStart.bind(r),r.handleLeave=r.handleLeave.bind(r),r.handleMove=r.handleMove.bind(r),t.addEventListener("touchstart",r.handleStart,{capture:!1}),t.addEventListener("touchcancel",r.handleLeave,{capture:!1}),document.addEventListener("touchend",r.handleLeave,{capture:!1,passive:!1}),document.addEventListener("touchmove",r.handleMove,{capture:!1,passive:!1}),r}return ne(a,n),K(a,[{key:"kill",value:function(){var e=this.container;e.removeEventListener("touchstart",this.handleStart),e.removeEventListener("touchcancel",this.handleLeave),document.removeEventListener("touchend",this.handleLeave),document.removeEventListener("touchmove",this.handleMove)}},{key:"getDimensions",value:function(){return{width:this.container.offsetWidth,height:this.container.offsetHeight}}},{key:"doesCapture",value:function(e){var r=this.settings.gestureTarget;return r==="graph"?!0:r==="page"?!1:e>=2}},{key:"syncStageFlags",value:function(){var e=this.touchMode===1&&this.hasMoved,r=this.touchMode===2;e!==this.isPanningStage&&(this.isPanningStage=e,this.renderer._setPanning(e)),r!==this.isZoomingStage&&(this.isZoomingStage=r,this.renderer._setZooming(r))}},{key:"handleStart",value:function(e){var r=this;if(this.enabled){var i=Gn(e.touches);if(this.touchMode=i.length,this.startCameraState=this.renderer.getCamera().getState(),this.startTouchesPositions=i.map(function(f){return ge(f,r.container)}),this.touchMode===2){var o=Q(this.startTouchesPositions,2),s=o[0],l=s.x,u=s.y,d=o[1],h=d.x,c=d.y;this.startTouchesAngle=Math.atan2(c-u,h-l),this.startTouchesDistance=Math.sqrt(Math.pow(h-l,2)+Math.pow(c-u,2))}this.syncStageFlags(),this.emit("touchdown",$t(e,this.lastTouches,this.container)),this.lastTouches=i,this.lastTouchesPositions=this.startTouchesPositions,e.cancelable&&(this.doesCapture(e.touches.length)||this.renderer._hasNodeDrag())&&e.preventDefault()}}},{key:"handleLeave",value:function(e){if(!(!this.enabled||!this.startTouchesPositions.length)){switch(e.cancelable&&this.doesCapture(this.touchMode)&&e.preventDefault(),this.movingTimeout&&(this.isMoving=!1,clearTimeout(this.movingTimeout)),this.touchMode){case 2:if(e.touches.length===1){this.handleStart(e);break}case 1:if(this.isMoving){var r=this.renderer.getCamera(),i=r.getState(),o=r.getPreviousState();r.animate({x:i.x+this.settings.inertiaRatio*(i.x-o.x),y:i.y+this.settings.inertiaRatio*(i.y-o.y)},{duration:this.settings.inertiaDuration,easing:"quadraticOut"})}this.hasMoved=!1,this.isMoving=!1,this.touchMode=0;break}if(this.syncStageFlags(),this.emit("touchup",$t(e,this.lastTouches,this.container)),!e.touches.length){var s=ge(this.lastTouches[0],this.container),l=this.startTouchesPositions[0],u=Math.pow(s.x-l.x,2)+Math.pow(s.y-l.y,2);if(!e.touches.length&&u<Math.pow(this.settings.tapMoveTolerance,2))if(this.lastTap&&Date.now()-this.lastTap.time<this.settings.doubleClickTimeout){var d=$t(e,this.lastTouches,this.container);if(this.emit("doubletap",d),this.lastTap=null,!d.sigmaDefaultPrevented&&this.settings.gestureTarget!=="page"){var h=this.renderer.getCamera(),c=h.getBoundedRatio(h.getState().ratio/this.settings.doubleClickZoomingRatio);h.animate(this.renderer.getViewportZoomedState(s,c),{easing:"quadraticInOut",duration:this.settings.doubleClickZoomingDuration})}}else{var f=$t(e,this.lastTouches,this.container);this.emit("tap",f),this.lastTap={time:Date.now(),position:f.touches[0]||f.previousTouches[0]}}}this.lastTouches=Gn(e.touches),this.startTouchesPositions=[]}}},{key:"handleMove",value:function(e){var r=this;if(!(!this.enabled||!this.startTouchesPositions.length)){var i=this.doesCapture(e.touches.length);i&&e.preventDefault();var o=Gn(e.touches),s=o.map(function(O){return ge(O,r.container)}),l=this.lastTouches;this.lastTouches=o,this.lastTouchesPositions=s;var u=$t(e,l,this.container);if(this.emit("touchmove",u),!u.sigmaDefaultPrevented&&(this.hasMoved||(this.hasMoved=s.some(function(O,q){var j=r.startTouchesPositions[q];return j&&(O.x!==j.x||O.y!==j.y)})),!!this.hasMoved)){if(!i){this.settings.gestureTarget==="shared"&&this.renderer._showGestureHint("touch");return}this.isMoving=!0,this.syncStageFlags(),this.movingTimeout&&clearTimeout(this.movingTimeout),this.movingTimeout=window.setTimeout(function(){r.isMoving=!1},this.settings.dragTimeout);var d=this.renderer.getCamera(),h=this.startCameraState,c=this.renderer.getSetting("stagePadding");switch(this.touchMode){case 1:{var f=this.renderer.viewportToFramedGraph((this.startTouchesPositions||[])[0]),g=f.x,m=f.y,p=this.renderer.viewportToFramedGraph(s[0]),v=p.x,y=p.y;d.setState({x:h.x+g-v,y:h.y+m-y});break}case 2:{var b={x:.5,y:.5,angle:0,ratio:1},T=s[0],x=T.x,_=T.y,S=s[1],A=S.x,R=S.y,w=Math.atan2(R-_,A-x)-this.startTouchesAngle,F=Math.hypot(R-_,A-x)/this.startTouchesDistance,D=d.getBoundedRatio(h.ratio/F);b.ratio=D,b.angle=h.angle+w;var I=this.getDimensions(),C=this.renderer.viewportToFramedGraph((this.startTouchesPositions||[])[0],{cameraState:h}),k=Math.min(I.width,I.height)-2*c,G=k/I.width,N=k/I.height,L=D/k,P=x-k/2/G,M=_-k/2/N,H=qn({x:P,y:M},b.angle);P=H.x,M=H.y,b.x=C.x-P*L,b.y=C.y+M*L,d.setState(b);break}}}}}},{key:"setSettings",value:function(e){this.settings=e}}])}(Ji),Zd=function(){function n(a,t,e,r){Y(this,n),E(this,"pendingNode",null),E(this,"session",null),this.graph=a,this.viewportToGraph=t,this.setNodesState=e,this.emit=r}return K(n,[{key:"start",value:function(t,e,r,i,o){var s=r(t),l=!1;if(this.emit("nodeDragStart",{node:t,allDraggedNodes:s,event:e,preventSigmaDefault:function(){l=!0}}),l)return!1;var u=new Map,d=z(s),h;try{for(d.s();!(h=d.n()).done;){var c=h.value;u.set(c,{x:this.graph.getNodeAttribute(c,i),y:this.graph.getNodeAttribute(c,o)})}}catch(f){d.e(f)}finally{d.f()}return this.session={node:t,allNodes:s,startPosition:this.viewportToGraph(e),startNodePositions:u,xAttr:i,yAttr:o},this.setNodesState(s,{isDragged:!0}),!0}},{key:"applyMove",value:function(t,e){var r=this.session,i=r.allNodes,o=r.startNodePositions,s=r.startPosition,l=r.xAttr,u=r.yAttr,d=this.viewportToGraph(t),h={x:d.x-s.x,y:d.y-s.y},c=z(i),f;try{for(c.s();!(f=c.n()).done;){var g=f.value,m=o.get(g);if(!(!m||!this.graph.hasNode(g))){var p={x:m.x+h.x,y:m.y+h.y};e?this.graph.mergeNodeAttributes(g,e(p,g)):(this.graph.setNodeAttribute(g,l,p.x),this.graph.setNodeAttribute(g,u,p.y))}}}catch(v){c.e(v)}finally{c.f()}}},{key:"end",value:function(){if(this.pendingNode=null,!this.session)return null;var t=this.session,e=t.node,r=t.allNodes;return this.setNodesState(r,{isDragged:!1}),this.session=null,{node:e,allNodes:r}}},{key:"removeNode",value:function(t){t===this.pendingNode&&(this.pendingNode=null),this.session&&(this.session.node===t?(this.setNodesState(this.session.allNodes,{isDragged:!1}),this.session=null):this.session.allNodes.includes(t)&&(this.session.allNodes=this.session.allNodes.filter(function(e){return e!==t}),this.session.startNodePositions.delete(t)))}},{key:"clear",value:function(){this.pendingNode=null,this.session=null}}])}();function zi(n,a){return n<a?"".concat(n,"\0").concat(a):"".concat(a,"\0").concat(n)}var Qd=function(){function n(a,t){Y(this,n),E(this,"groups",new Map),E(this,"edgeToGroupKey",new Map),this.graph=a,this.onGroupChanged=t}return K(n,[{key:"getGroupKey",value:function(t){return zi(this.graph.source(t),this.graph.target(t))}},{key:"sortGroup",value:function(t,e){var r=this,i=e.split("\0")[0];t.sort(function(o,s){var l=r.graph.source(o)===i||!r.graph.isDirected(o)?0:1,u=r.graph.source(s)===i||!r.graph.isDirected(s)?0:1;return l-u})}},{key:"register",value:function(t){var e=this.getGroupKey(t),r=this.groups.get(e);r||(r=[],this.groups.set(e,r)),r.includes(t)||r.push(t),this.edgeToGroupKey.set(t,e),r.length>1&&this.sortGroup(r,e),this.onGroupChanged(r,r.length)}},{key:"unregister",value:function(t){var e=this.edgeToGroupKey.get(t);if(e){this.edgeToGroupKey.delete(t);var r=this.groups.get(e);if(r){var i=r.indexOf(t);i!==-1&&r.splice(i,1),r.length===0?this.groups.delete(e):this.onGroupChanged(r,r.length)}}}},{key:"getGroup",value:function(t){var e,r=this.edgeToGroupKey.get(t);return r?(e=this.groups.get(r))!==null&&e!==void 0?e:[]:[]}},{key:"getSiblings",value:function(t){return this.getGroup(t).filter(function(e){return e!==t})}},{key:"rebuild",value:function(){var t=this;this.groups.clear(),this.edgeToGroupKey.clear(),this.graph.forEachEdge(function(l,u,d,h){var c=zi(d,h),f=t.groups.get(c);f||(f=[],t.groups.set(c,f)),f.push(l),t.edgeToGroupKey.set(l,c)});var e=z(this.groups),r;try{for(e.s();!(r=e.n()).done;){var i=Q(r.value,2),o=i[0],s=i[1];s.length>1&&this.sortGroup(s,o),this.onGroupChanged(s,s.length)}}catch(l){e.e(l)}finally{e.f()}}},{key:"clear",value:function(){this.groups.clear(),this.edgeToGroupKey.clear()}}])}();function Wi(n,a){var t;if(n===!1||n==="extend"||n==="separate")return n;var e=n[a];return e!==void 0?e:(t=n.default)!==null&&t!==void 0?t:!1}function Bi(n){return n===!1?!1:n==="extend"||n==="separate"?!0:Object.values(n).some(function(a){return a==="extend"||a==="separate"})}function Ui(n){return n==="separate"?!0:n===!1||n==="extend"?!1:n.default==="separate"?!0:Object.values(n).includes("separate")}var ue={node:{parent:null,eventSuffix:"Node",payloadKey:"node",isEnabled:function(){return!0},writesPickingThisFrame:function(){return!0},setHover:function(a,t,e){return a.setNodeState(t,{isHovered:e})},getCursor:function(a,t){var e;return(e=a.nodeDataCache[t])===null||e===void 0?void 0:e.cursor},isHitValid:function(a,t){var e;return((e=a.nodeDataCache[t])===null||e===void 0?void 0:e.visibility)!=="hidden"}},edge:{parent:null,eventSuffix:"Edge",payloadKey:"edge",isEnabled:function(a){return!!a.settings.enableEdgeEvents},writesPickingThisFrame:function(a){return!!a.settings.enableEdgeEvents},setHover:function(a,t,e){return a.setEdgeState(t,{isHovered:e})},getCursor:function(a,t){var e;return(e=a.edgeDataCache[t])===null||e===void 0?void 0:e.cursor}},nodeLabel:{parent:"node",eventSuffix:"NodeLabel",payloadKey:"node",isEnabled:function(a){return Ui(a.settings.nodeLabelEvents)},writesPickingThisFrame:function(a){return Bi(a.settings.nodeLabelEvents)},setHover:function(a,t,e){return a.setNodeState(t,{isLabelHovered:e})},getCursor:function(a,t){var e;return(e=a.nodeDataCache[t])===null||e===void 0?void 0:e.labelCursor},resolveForVerb:function(a,t,e){var r=Wi(e.settings.nodeLabelEvents,t);return r===!1?null:r==="extend"?{kind:"node",key:a.key}:a}},edgeLabel:{parent:"edge",eventSuffix:"EdgeLabel",payloadKey:"edge",isEnabled:function(a){return Ui(a.settings.edgeLabelEvents)},writesPickingThisFrame:function(a){return Bi(a.settings.edgeLabelEvents)},setHover:function(a,t,e){return a.setEdgeState(t,{isLabelHovered:e})},getCursor:function(a,t){var e;return(e=a.edgeDataCache[t])===null||e===void 0?void 0:e.labelCursor},resolveForVerb:function(a,t,e){var r=Wi(e.settings.edgeLabelEvents,t);return r===!1?null:r==="extend"?{kind:"edge",key:a.key}:a}}},tt=["node","edge","nodeLabel","edgeLabel"];function Jd(){return{lookup:[null],idsByKind:{node:new Map,edge:new Map,nodeLabel:new Map,edgeLabel:new Map},nextId:1}}function et(n,a,t){var e;return(e=n.idsByKind[a].get(t))!==null&&e!==void 0?e:0}function La(n,a){var t=z(tt),e;try{for(t.s();!(e=t.n()).done;){var r=e.value;if(r===a||ue[r].parent===a){var i=z(n.idsByKind[r].values()),o;try{for(i.s();!(o=i.n()).done;){var s=o.value;n.lookup[s]=null}}catch(c){i.e(c)}finally{i.f()}n.idsByKind[r]=new Map}}}catch(c){t.e(c)}finally{t.f()}var l=1,u=z(tt),d;try{for(u.s();!(d=u.n()).done;){var h=d.value;if(h===a)break;l+=n.idsByKind[h].size}}catch(c){u.e(c)}finally{u.f()}n.nextId=l}function Oi(n,a,t){var e=n.nextId++;return n.idsByKind[a].set(t,e),n.lookup[e]={kind:a,key:t},e}function eh(n,a){var t=z(tt),e;try{for(t.s();!(e=t.n()).done;){var r=e.value;if(ue[r].parent!==null){var i=z(n.idsByKind[r].values()),o;try{for(i.s();!(o=i.n()).done;){var s=o.value;n.lookup[s]=null}}catch(x){i.e(x)}finally{i.f()}n.idsByKind[r]=new Map}}}catch(x){t.e(x)}finally{t.f()}n.nextId=1;var l=z(tt),u;try{for(l.s();!(u=l.n()).done;){var d=u.value;if(ue[d].parent===null){var h=z(n.idsByKind[d].values()),c;try{for(h.s();!(c=h.n()).done;){var f=c.value;f>=n.nextId&&(n.nextId=f+1)}}catch(x){h.e(x)}finally{h.f()}}}}catch(x){l.e(x)}finally{l.f()}var g=z(tt),m;try{for(g.s();!(m=g.n()).done;){var p=m.value,v=ue[p];if(!(v.parent===null||!v.isEnabled(a))){var y=z(n.idsByKind[v.parent].keys()),b;try{for(y.s();!(b=y.n()).done;){var T=b.value;n.idsByKind[p].set(T,n.nextId),n.lookup[n.nextId]={kind:p,key:T},n.nextId++}}catch(x){y.e(x)}finally{y.f()}}}}catch(x){g.e(x)}finally{g.f()}}function th(n,a){var t=z(tt),e;try{for(t.s();!(e=t.n()).done;){var r=e.value,i=n[r],o=a[r];if(i!==o){if(i.size!==o.size)return!1;var s=z(i),l;try{for(s.s();!(l=s.n()).done;){var u=Q(l.value,2),d=u[0],h=u[1];if(o.get(d)!==h)return!1}}catch(c){s.e(c)}finally{s.f()}}}}catch(c){t.e(c)}finally{t.f()}return!0}function Hi(n,a,t){ue[a.kind].setHover(n,a.key,t)}function nh(n,a){return ue[a.kind].getCursor(n,a.key)}function jt(n,a){return"".concat(a).concat(ue[n].eventSuffix)}function Xt(n,a){return W(W({},a),{},E({},ue[n.kind].payloadKey,n.key))}function ah(n,a,t){var e=ue[a.kind].resolveForVerb;return e?e(a,t,n):a}function rh(n,a){var t=ue[a.kind].isHitValid;return t?t(n,a.key):!0}function ka(n){return tt.filter(function(a){return a===n||ue[a].parent===n})}function eo(n,a,t){return a&&(a=ah(n,a,t)),a&&!rh(n,a)&&(a=null),a}function Pa(n,a,t){var e=t==="wheel"?n.stateManager.hovered:n.getHitAtPosition(a);return eo(n,e,t)}function ih(n,a){return!n||!a?n===a:n.kind===a.kind&&n.key===a.key}function to(n,a,t){var e={event:t,preventSigmaDefault:function(){return t.preventSigmaDefault()}},r=n.dragManager.session,i=r?{kind:"node",key:r.node}:eo(n,a,"enter"),o=n.stateManager,s=o.hovered;ih(s,i)||(s&&(Hi(n,s,!1),n.emit(jt(s.kind,"leave"),Xt(s,e))),o.setHovered(i),i&&(Hi(n,i,!0),n.emit(jt(i.kind,"enter"),Xt(i,e))),n.updateContainerCursor())}function oh(n,a,t,e){e.handleResize=function(){return n.scheduleRefresh()},window.addEventListener("resize",e.handleResize),e.handleMove=function(i){n.hoverResolver.pointerMoved(Qe(i))},e.handleMoveBody=function(i){var o=Qe(i),s=n.dragManager;if(s.pendingNode&&!s.session){var l=n.nodeStyleAnalysis,u=l.xAttribute,d=l.yAttribute,h=n.settings;s.start(s.pendingNode,o,h.getDraggedNodes,u||"x",d||"y"),s.pendingNode=null}s.session&&(s.applyMove(o,n.settings.dragPositionToAttributes),n.emit("nodeDrag",{node:s.session.node,allDraggedNodes:s.session.allNodes,event:o}),o.preventSigmaDefault()),n.emit("moveBody",{event:o,preventSigmaDefault:function(){return o.preventSigmaDefault()}})},e.handleLeave=function(i){var o=Qe(i),s={event:o,preventSigmaDefault:function(){return o.preventSigmaDefault()}};n.hoverResolver.pointerLeft(),to(n,null,o),n.emit("leaveStage",s)},e.handleEnter=function(i){var o=Qe(i);n.emit("enterStage",{event:o,preventSigmaDefault:function(){return o.preventSigmaDefault()}})};var r=function(o){return function(s){var l=Qe(s),u={event:l,preventSigmaDefault:function(){return l.preventSigmaDefault()}},d=Pa(n,l,o);if(d){n.emit(jt(d.kind,o),Xt(d,u));return}n.emit("".concat(o,"Stage"),u)}};e.handleClick=r("click"),e.handleRightClick=r("rightClick"),e.handleDoubleClick=r("doubleClick"),e.handleWheel=r("wheel"),e.handleDown=function(i){var o=Qe(i),s={event:o,preventSigmaDefault:function(){return o.preventSigmaDefault()}},l=Pa(n,o,"down");if(l){l.kind==="node"&&n.settings.enableNodeDrag&&(n.dragManager.pendingNode=l.key),n.emit(jt(l.kind,"down"),Xt(l,s));return}n.emit("downStage",s)},e.handleUp=function(i){var o=Qe(i),s={event:o,preventSigmaDefault:function(){return o.preventSigmaDefault()}},l=n.dragManager.end();l&&n.emit("nodeDragEnd",W({node:l.node,allDraggedNodes:l.allNodes},s));var u=Pa(n,o,"up");if(u){n.emit(jt(u.kind,"up"),Xt(u,s));return}n.emit("upStage",s)},a.on("mousemove",e.handleMove),a.on("mousemovebody",e.handleMoveBody),a.on("click",e.handleClick),a.on("rightClick",e.handleRightClick),a.on("doubleClick",e.handleDoubleClick),a.on("wheel",e.handleWheel),a.on("mousedown",e.handleDown),a.on("mouseup",e.handleUp),a.on("mouseleave",e.handleLeave),a.on("mouseenter",e.handleEnter),t.on("touchdown",e.handleDown),t.on("touchdown",e.handleMove),t.on("touchup",e.handleUp),t.on("touchmove",e.handleMove),t.on("tap",e.handleClick),t.on("doubletap",e.handleDoubleClick),t.on("touchmove",e.handleMoveBody)}function sh(n,a){var t=n.graph,e=new Set(["x","y","zIndex","type"]);a.eachNodeAttributesUpdatedGraphUpdate=function(r){var i,o=(i=r.hints)===null||i===void 0?void 0:i.attributes,s=!o||o.some(function(l){return e.has(l)});n.refresh({partialGraph:{nodes:t.nodes()},skipIndexation:!s,schedule:!0})},a.eachEdgeAttributesUpdatedGraphUpdate=function(r){var i,o=(i=r.hints)===null||i===void 0?void 0:i.attributes,s=o&&["zIndex","type"].some(function(l){return o?.includes(l)});n.refresh({partialGraph:{edges:t.edges()},skipIndexation:!s,schedule:!0})},a.addNodeGraphUpdate=function(r){n.addNode(r.key),n.refresh({partialGraph:{nodes:[r.key]},skipIndexation:!1,schedule:!0})},a.updateNodeGraphUpdate=function(r){n.refresh({partialGraph:{nodes:[r.key]},skipIndexation:!1,schedule:!0})},a.dropNodeGraphUpdate=function(r){n.removeNode(r.key),n.refresh({schedule:!0})},a.addEdgeGraphUpdate=function(r){var i=r.key;n.edgeGroups.register(i),n.addEdge(i);var o=n.edgeGroups.getSiblings(i),s=z(o),l;try{for(s.s();!(l=s.n()).done;){var u=l.value;n.addEdge(u)}}catch(d){s.e(d)}finally{s.f()}n.refresh({partialGraph:{edges:[i].concat($(o))},schedule:!0})},a.updateEdgeGraphUpdate=function(r){n.refresh({partialGraph:{edges:[r.key]},skipIndexation:!1,schedule:!0})},a.dropEdgeGraphUpdate=function(r){var i=r.key,o=n.edgeGroups.getSiblings(i);n.edgeGroups.unregister(i),n.removeEdge(i);var s=z(o),l;try{for(s.s();!(l=s.n()).done;){var u=l.value;n.addEdge(u)}}catch(d){s.e(d)}finally{s.f()}n.refresh({schedule:!0})},a.clearEdgesGraphUpdate=function(){n.clearEdgeState(),n.clearEdgeIndices(),n.refresh({schedule:!0})},a.clearGraphUpdate=function(){n.clearEdgeState(),n.clearNodeState(),n.clearEdgeIndices(),n.clearNodeIndices(),n.refresh({schedule:!0})},t.on("nodeAdded",a.addNodeGraphUpdate),t.on("nodeDropped",a.dropNodeGraphUpdate),t.on("nodeAttributesUpdated",a.updateNodeGraphUpdate),t.on("eachNodeAttributesUpdated",a.eachNodeAttributesUpdatedGraphUpdate),t.on("edgeAdded",a.addEdgeGraphUpdate),t.on("edgeDropped",a.dropEdgeGraphUpdate),t.on("edgeAttributesUpdated",a.updateEdgeGraphUpdate),t.on("eachEdgeAttributesUpdated",a.eachEdgeAttributesUpdatedGraphUpdate),t.on("edgesCleared",a.clearEdgesGraphUpdate),t.on("cleared",a.clearGraphUpdate)}function lh(n,a){n.removeListener("nodeAdded",a.addNodeGraphUpdate),n.removeListener("nodeDropped",a.dropNodeGraphUpdate),n.removeListener("nodeAttributesUpdated",a.updateNodeGraphUpdate),n.removeListener("eachNodeAttributesUpdated",a.eachNodeAttributesUpdatedGraphUpdate),n.removeListener("edgeAdded",a.addEdgeGraphUpdate),n.removeListener("edgeDropped",a.dropEdgeGraphUpdate),n.removeListener("edgeAttributesUpdated",a.updateEdgeGraphUpdate),n.removeListener("eachEdgeAttributesUpdated",a.eachEdgeAttributesUpdatedGraphUpdate),n.removeListener("edgesCleared",a.clearEdgesGraphUpdate),n.removeListener("cleared",a.clearGraphUpdate)}var uh={x:.5,y:.5,angle:0,ratio:1},dh=8,hh=.001;function ch(n){var a=n.coords,t=n.nodeData,e=n.dimensions,r=n.stagePadding,i=n.zoomToSizeRatioFunction,o=n.itemSizesReference,s=n.fitLabels,l=n.nodeLabelBox,u=Object.keys(a);if(!u.length)return n.extent;for(var d=i(1)||1,h=o==="positions",c=e.width,f=e.height,g=n.extent,m=0;m<dh;m++){for(var p=yn(g),v={width:g.x[1]-g.x[0]||1,height:g.y[1]-g.y[0]||1},y=Me(uh,e,v,r),b=$i(y,p({x:0,y:0}),c,f),T=$i(y,p({x:1,y:0}),c,f),x=Math.hypot(T.x-b.x,T.y-b.y)||1,_=1/0,S=-1/0,A=1/0,R=-1/0,w=0,F=u.length;w<F;w++){var D=u[w],I=t[D],C=I.size/d*(h?x:1),k=-C,G=C,N=-C,L=C;if(s){var P=l(I,C);P&&(P.minX<k&&(k=P.minX),P.maxX>G&&(G=P.maxX),P.minY<N&&(N=P.minY),P.maxY>L&&(L=P.maxY))}var M=a[D],H=M.x,O=M.y;_=Math.min(_,H+k/x),S=Math.max(S,H+G/x),A=Math.min(A,O-L/x),R=Math.max(R,O-N/x)}var q={x:[_,S],y:[A,R]},j=Math.max(q.x[1]-q.x[0],q.y[1]-q.y[0])||1,X=Math.max(Math.abs(q.x[0]-g.x[0]),Math.abs(q.x[1]-g.x[1]),Math.abs(q.y[0]-g.y[0]),Math.abs(q.y[1]-g.y[1]));if(g=q,X/j<hh)break}return g}function $i(n,a,t,e){var r=ut(n,a);return{x:(1+r.x)*t/2,y:(1-r.y)*e/2}}var fh=typeof navigator<"u"&&/Mac|iP(hone|ad|od)/.test(navigator.platform),gh=1500,vh=`.sigma-gesture-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 1em;
  background: #00000066;
  color: #ffffff;
  font-size: 1em;
  pointer-events: none;
  transition: opacity 0.1s;
}`;function Vi(n){var a,t,e=gt("style");e.textContent=n,document.head.appendChild(e);var r=((a=(t=e.sheet)===null||t===void 0?void 0:t.cssRules.length)!==null&&a!==void 0?a:0)>0;return e.remove(),r}var Je=null;function ph(){return Je===null&&(Je=vh,Vi("@scope {}")&&(Je=`@scope {
`.concat(Je,`
}`)),Vi("@layer sigma-gesture-hint {}")&&(Je=`@layer sigma-gesture-hint {
`.concat(Je,`
}`))),Je}var mh=function(){function n(a){Y(this,n),E(this,"hideTimeout",null),this.styleElement=gt("style"),this.styleElement.textContent=ph(),a.appendChild(this.styleElement),this.element=gt("div",{opacity:"0"},{class:"sigma-gesture-hint"}),a.appendChild(this.element)}return K(n,[{key:"show",value:function(t,e){var r=this,i=t==="touch"?e.sharedGestureTouchMessage:fh?e.sharedGestureAppleWheelMessage:e.sharedGestureWheelMessage;i&&(this.element.textContent=i,this.element.style.opacity="1",typeof this.hideTimeout=="number"&&clearTimeout(this.hideTimeout),this.hideTimeout=window.setTimeout(function(){r.hideTimeout=null,r.element.style.opacity="0"},gh))}},{key:"kill",value:function(){typeof this.hideTimeout=="number"&&clearTimeout(this.hideTimeout),this.styleElement.remove(),this.element.remove()}}])}(),yh=function(){function n(a){Y(this,n),E(this,"readBuffer",null),E(this,"fence",null),E(this,"result",new Uint8Array(4)),E(this,"generation",0),E(this,"readGeneration",0),E(this,"lastEvent",null),E(this,"active",!1),E(this,"dirty",!1),E(this,"rafId",null),E(this,"killed",!1),this.options=a}return K(n,[{key:"pointerMoved",value:function(t){this.lastEvent=t,this.active=!0,!this.options.isRenderPending()&&this.request()}},{key:"pointerLeft",value:function(){this.active=!1,this.dirty=!1}},{key:"frameRendered",value:function(){this.request()}},{key:"invalidate",value:function(){this.generation++}},{key:"request",value:function(){if(!(this.killed||!this.active||!this.lastEvent)){if(this.fence){this.dirty=!0;return}this.startRead()}}},{key:"startRead",value:function(){var t=this.options,e=t.gl,r=t.getFrameBuffer,i=t.getPixelRatio,o=t.getDownSizingRatio;this.readGeneration=this.generation;var s=this.lastEvent,l=Yn(e,s.x,s.y,i(),o()),u=Q(l,2),d=u[0],h=u[1];this.readBuffer||(this.readBuffer=e.createBuffer()),e.bindFramebuffer(e.FRAMEBUFFER,r()),e.bindBuffer(e.PIXEL_PACK_BUFFER,this.readBuffer),e.bufferData(e.PIXEL_PACK_BUFFER,4,e.STREAM_READ),e.readPixels(d,h,1,1,e.RGBA,e.UNSIGNED_BYTE,0),e.bindBuffer(e.PIXEL_PACK_BUFFER,null),e.bindFramebuffer(e.FRAMEBUFFER,null),this.fence=e.fenceSync(e.SYNC_GPU_COMMANDS_COMPLETE,0),e.flush(),this.schedulePoll(s)}},{key:"schedulePoll",value:function(t){var e=this;this.rafId=requestAnimationFrame(function(){e.rafId=null,e.poll(t)})}},{key:"poll",value:function(t){var e=this.options,r=e.gl,i=e.onIndex;if(!(this.killed||!this.fence)){var o=r.clientWaitSync(this.fence,0,0);if(o===r.TIMEOUT_EXPIRED){this.schedulePoll(t);return}if(r.deleteSync(this.fence),this.fence=null,o!==r.WAIT_FAILED&&this.readGeneration===this.generation){r.bindBuffer(r.PIXEL_PACK_BUFFER,this.readBuffer),r.getBufferSubData(r.PIXEL_PACK_BUFFER,0,this.result),r.bindBuffer(r.PIXEL_PACK_BUFFER,null);var s=Q(this.result,4),l=s[0],u=s[1],d=s[2],h=s[3];this.active&&i(Kn(l,u,d,h),t)}this.dirty&&(this.dirty=!1,this.active&&this.lastEvent&&!this.options.isRenderPending()&&this.startRead())}}},{key:"reset",value:function(){this.rafId!==null&&cancelAnimationFrame(this.rafId),this.rafId=null,this.fence=null,this.readBuffer=null,this.dirty=!1}},{key:"kill",value:function(){this.killed=!0,this.rafId!==null&&cancelAnimationFrame(this.rafId),this.rafId=null;var t=this.options.gl;this.fence&&t.deleteSync(this.fence),this.fence=null,this.readBuffer&&t.deleteBuffer(this.readBuffer),this.readBuffer=null}}])}(),ji=function(){function n(a,t){Y(this,n),this.key=a,this.size=t}return K(n,null,[{key:"compare",value:function(t,e){return t.size>e.size?-1:t.size<e.size||t.key>e.key?1:-1}}])}(),Nn=function(){function n(){Y(this,n),E(this,"width",0),E(this,"height",0),E(this,"cellSize",0),E(this,"columns",0),E(this,"rows",0),E(this,"cells",{})}return K(n,[{key:"resizeAndClear",value:function(t,e){this.width=t.width,this.height=t.height,this.cellSize=e,this.columns=Math.ceil(t.width/e),this.rows=Math.ceil(t.height/e),this.cells={}}},{key:"getIndex",value:function(t){var e=Math.floor(t.x/this.cellSize),r=Math.floor(t.y/this.cellSize);return r*this.columns+e}},{key:"add",value:function(t,e,r){var i=new ji(t,e),o=this.getIndex(r),s=this.cells[o];s||(s=[],this.cells[o]=s),s.push(i)}},{key:"organize",value:function(){for(var t in this.cells){var e=this.cells[t];e.sort(ji.compare)}}},{key:"getLabelsToDisplay",value:function(t,e,r){var i=this.cellSize*this.cellSize,o=i/t/t,s=o*e/i,l=Math.ceil(s),u=[];if(r)for(var d=Math.max(0,Math.floor(r.x1/this.cellSize)),h=Math.min(this.columns-1,Math.floor(r.x2/this.cellSize)),c=Math.max(0,Math.floor(r.y1/this.cellSize)),f=Math.min(this.rows-1,Math.floor(r.y2/this.cellSize)),g=c;g<=f;g++)for(var m=d;m<=h;m++){var p=g*this.columns+m,v=this.cells[p];if(v)for(var y=0;y<Math.min(l,v.length);y++)u.push(v[y].key)}else for(var b in this.cells)for(var T=this.cells[b],x=0;x<Math.min(l,T.length);x++)u.push(T[x].key);return u}}])}();function bh(n){var a=n.graph,t=n.hoveredNode,e=n.highlightedNodes,r=n.displayedNodeLabels,i=new Set,o=new Set(e);t&&o.add(t);var s=z(o),l;try{for(s.s();!(l=s.n()).done;){var u=l.value;a.hasNode(u)&&a.forEachEdge(u,function(f){i.add(f)})}}catch(f){s.e(f)}finally{s.f()}var d=z(r),h;try{var c=function(){var g=h.value;if(o.has(g))return 1;a.forEachEdge(g,function(m,p,v,y){var b=v===g?y:v;r.has(b)&&i.add(m)})};for(d.s();!(h=d.n()).done;)c()}catch(f){d.e(f)}finally{d.f()}return Array.from(i)}var Tt=150,Et=50,xh={both:0,node:1,label:2},_h={over:0,above:1,below:2,auto:3},Xi=12,Th=3,Eh=function(){function n(a){Y(this,n),E(this,"labelGrid",new Nn),E(this,"edgeAnchorGrid",new Nn),E(this,"displayedNodeLabels",new Set),E(this,"displayedEdgeLabels",new Set),E(this,"edgeLabelCandidates",[]),E(this,"renderedNodeLabels",new Set),E(this,"labelSizeCache",new Map),E(this,"framePassPoints",new Float32Array(0)),E(this,"labelsDirty",!0),this.internals=a}return K(n,[{key:"resetFrame",value:function(){this.displayedNodeLabels=new Set,this.renderedNodeLabels=new Set,this.labelSizeCache.clear()}},{key:"clearEdgeLabels",value:function(){this.displayedEdgeLabels=new Set}},{key:"resetLabelGrid",value:function(){this.labelGrid=new Nn,this.edgeAnchorGrid=new Nn}},{key:"processWebGLLabels",value:function(t){for(var e,r=this.internals,i=r.labelProgram,o=r.primitives,s=r.nodeDataCache,l=(o==null||(e=o.nodes)===null||e===void 0||(e=e.label)===null||e===void 0||(e=e.font)===null||e===void 0?void 0:e.family)||"sans-serif",u=new Map,d=0,h=t.length;d<h;d++){var c=t[d],f=s[c];if(!(f.visibility==="hidden"||!f.label)){var g=f.labelFont||l,m=u.get(g);m?m.push(f.label):u.set(g,[f.label])}}var p=z(u),v;try{for(p.s();!(v=p.n()).done;){var y=Q(v.value,2),b=y[0],T=y[1],x=_n(b),_=x.family,S=x.weight,A=x.style,R=i.registerFont(_,S,A);i.ensureGlyphsReady(T,R)}}catch(w){p.e(w)}finally{p.f()}}},{key:"measureNodeLabel",value:function(t){var e,r;if(!t.label)return{width:0,height:0,textHeight:0};var i=this.internals,o=i.labelProgram,s=i.primitives,l=(e=t.labelSize)!==null&&e!==void 0?e:14,u=t.labelFont||(s==null||(r=s.nodes)===null||r===void 0||(r=r.label)===null||r===void 0||(r=r.font)===null||r===void 0?void 0:r.family)||"sans-serif",d="".concat(t.label,"|").concat(l,"|").concat(u);if(this.labelSizeCache.has(d))return this.labelSizeCache.get(d);var h=_n(u),c=h.family,f=h.weight,g=h.style,m=o.registerFont(c,f,g),p=o.measureLabel(t.label,l,m);return this.labelSizeCache.set(d,p),p}},{key:"nodeLabelBox",value:function(t,e){var r,i,o,s,l;if(t.visibility==="hidden"||t.labelVisibility==="hidden")return null;var u=this.measureNodeLabel(t),d=u.width,h=u.height,c=u.textHeight;if(!d)return null;var f=(r=(i=this.internals.primitives)===null||i===void 0||(i=i.nodes)===null||i===void 0||(i=i.label)===null||i===void 0?void 0:i.margin)!==null&&r!==void 0?r:mt,g=e+f,m=t.labelBackgroundColor?(o=t.labelBackgroundPadding)!==null&&o!==void 0?o:ya:0,p=d/2,v=h/2,y=p+m,b=v+m,T=c/2,x=0,_=0;switch((s=t.labelPosition)!==null&&s!==void 0?s:"right"){case"left":x=-(g+p);break;case"above":_=-(g+T);break;case"below":_=g+T;break;case"over":break;default:x=g+p}var S=(l=t.labelAngle)!==null&&l!==void 0?l:0,A=qn({x,y:_},S),R=A.x,w=A.y,F=Math.abs(Math.cos(S)),D=Math.abs(Math.sin(S)),I=F*y+D*b,C=D*y+F*b;return{minX:R-I,maxX:R+I,minY:w-C,maxY:w+C}}},{key:"computeDisplayedNodeLabels",value:function(){var t=this.internals.getCameraState(),e=this.internals.getDimensions(),r=e.width,i=e.height,o=this.internals.viewportToFramedGraph({x:-Tt,y:-Et}),s=this.internals.viewportToFramedGraph({x:r+Tt,y:-Et}),l=this.internals.viewportToFramedGraph({x:-Tt,y:i+Et}),u=this.internals.viewportToFramedGraph({x:r+Tt,y:i+Et}),d=Math.min(o.x,s.x,l.x,u.x),h=Math.max(o.x,s.x,l.x,u.x),c=Math.min(o.y,s.y,l.y,u.y),f=Math.max(o.y,s.y,l.y,u.y),g=Me({x:.5,y:.5,ratio:1,angle:0},{width:r,height:i},this.internals.getGraphDimensions(),this.internals.getStagePadding()),m=function(P){var M=ut(g,P);return{x:(1+M.x)*r/2,y:(1-M.y)*i/2}},p=m({x:d,y:c}),v=m({x:h,y:c}),y=m({x:d,y:f}),b=m({x:h,y:f}),T={x1:Math.min(p.x,v.x,y.x,b.x),y1:Math.min(p.y,v.y,y.y,b.y),x2:Math.max(p.x,v.x,y.x,b.x),y2:Math.max(p.y,v.y,y.y,b.y)},x=this.internals,_=x.settings,S=x.nodeDataCache,A=x.nodesWithForcedLabels,R=this.labelGrid.getLabelsToDisplay(t.ratio,_.labelDensity,T);la(R,A);for(var w=0,F=R.length;w<F;w++){var D=R[w],I=S[D];if(!this.displayedNodeLabels.has(D)&&!(I.visibility==="hidden"||I.labelVisibility==="hidden")&&I.label&&!(I.x<d||I.x>h||I.y<c||I.y>f)){var C=this.internals.framedGraphToViewport(I),k=C.x,G=C.y,N=this.internals.scaleSize(I.size);!We(I)&&N<_.labelRenderedSizeThreshold||k<-Tt-N||k>r+Tt+N||G<-Et-N||G>i+Et+N||this.displayedNodeLabels.add(D)}}}},{key:"buildFramePassPoints",value:function(){var t=this.internals,e=t.nodeDataCache,r=t.nodeDataTexture;if(!r)return{data:this.framePassPoints,count:0};var i=this.displayedNodeLabels.size*3;this.framePassPoints.length<i&&(this.framePassPoints=new Float32Array(i));var o=this.framePassPoints,s=0,l=z(this.displayedNodeLabels),u;try{for(l.s();!(u=l.n()).done;){var d,h,c=u.value,f=e[c];if(f){var g=r.getIndex(c);g<0||(o[s*3]=g,o[s*3+1]=(d=pt[f.labelPosition||Ie.labelPosition])!==null&&d!==void 0?d:0,o[s*3+2]=(h=f.labelAngle)!==null&&h!==void 0?h:0,s++)}}}catch(m){l.e(m)}finally{l.f()}return{data:o,count:s}}},{key:"renderWebGLLabels",value:function(t,e){var r=this.internals,i=r.nodeDataCache,o=r.labelProgram,s=r.primitives,l=r.nodeDataTexture,u=[],d=z(this.displayedNodeLabels),h;try{for(d.s();!(h=d.n()).done;){var c=h.value;if(!this.renderedNodeLabels.has(c)){var f=i[c];e&&f.labelDepth!==e||(this.renderedNodeLabels.add(c),u.push(c))}}}catch(he){d.e(he)}finally{d.f()}if(u.length!==0){if(this.labelsDirty){for(var g,m,p,v=0,y=0,b=u.length;y<b;y++){var T=i[u[y]];v+=T.label.length}o.reallocate(v);for(var x=14,_=(g=s==null||(m=s.nodes)===null||m===void 0||(m=m.label)===null||m===void 0?void 0:m.margin)!==null&&g!==void 0?g:mt,S=Ie.labelPosition,A=(s==null||(p=s.nodes)===null||p===void 0||(p=p.label)===null||p===void 0||(p=p.font)===null||p===void 0?void 0:p.family)||"sans-serif",R=new Map,w=0,F=0,D=u.length;F<D;F++){var I,C,k,G,N=u[F],L=i[N],P=L.labelFont||A,M=R.get(P);if(M===void 0){var H=_n(P),O=H.family,q=H.weight,j=H.style;M=o.registerFont(O,q,j),R.set(P,M)}var X={text:L.label,x:L.x,y:L.y,size:(I=L.labelSize)!==null&&I!==void 0?I:x,color:L.labelColor,nodeSize:L.size,margin:_,position:(C=L.labelPosition)!==null&&C!==void 0?C:S,hidden:!1,forceLabel:We(L),type:"default",zIndex:(k=L.zIndex)!==null&&k!==void 0?k:0,parentType:"node",parentKey:N,fontKey:M,labelAngle:(G=L.labelAngle)!==null&&G!==void 0?G:0,nodeIndex:l.getIndex(N)},Ee=o.processLabel(N,w,X);w+=Ee}o.invalidateBuffers()}o.render(t)}}},{key:"renderBackdrops",value:function(t,e){var r=this.internals,i=r.backdropProgram,o=r.nodeDataCache,s=r.nodesWithBackdrop,l=r.attachmentManager,u=r.pixelRatio,d=r.nodeDataTexture,h=[],c=z(s),f;try{for(c.s();!(f=c.n()).done;){var g,m=f.value,p=o[m];if(!(!p||p.visibility==="hidden")&&!(e&&p.depth!==e)){var v=(g=d?.getIndex(m))!==null&&g!==void 0?g:-1;v<0||h.push({key:m,nodeIndex:v})}}}catch($e){c.e($e)}finally{c.f()}if(h.length!==0){i.reallocate(h.length);for(var y=0;y<h.length;y++){var b,T,x,_,S,A,R,w,F=h[y],D=F.key,I=F.nodeIndex,C=o[D],k=this.displayedNodeLabels.has(D),G=k?this.measureNodeLabel(C):{width:0,height:0,textHeight:0},N=G.textHeight,L=G.width,P=G.height,M=0,H=0;if(k&&C.labelAttachment&&l){var O=l.getEntry(D,C.labelAttachment);if(O){var q=C.labelAttachmentPlacement||"below";if(q==="below"||q==="above"){var j=O.height/u;P+=j+Oe,L=Math.max(L,O.width/u),H=q==="below"?(j+Oe)/2:-(j+Oe)/2}else{var X=O.width/u;L+=X+Oe,P=Math.max(P,O.height/u),M=q==="right"?(X+Oe)/2:-(X+Oe)/2}}}var Ee=C.backdropColor?ze(C.backdropColor):[255,255,255,255],he=C.backdropShadowColor?ze(C.backdropShadowColor):[0,0,0,128],Le=Ee.map(function($e){return $e/255}),nt=he.map(function($e){return $e/255}),St=(b=C.backdropShadowBlur)!==null&&b!==void 0?b:12,At=(T=C.backdropPadding)!==null&&T!==void 0?T:6,wt=C.backdropBorderColor?ze(C.backdropBorderColor):[0,0,0,0],Po=wt.map(function($e){return $e/255}),Fo=(x=C.backdropBorderWidth)!==null&&x!==void 0?x:0,Io=(_=C.backdropCornerRadius)!==null&&_!==void 0?_:0,za=(S=C.backdropLabelPadding)!==null&&S!==void 0?S:-1,No=za<0?At:za,Go=(A=xh[(R=C.backdropArea)!==null&&R!==void 0?R:"both"])!==null&&A!==void 0?A:0,Mo={key:D,nodeIndex:I,label:C.label,labelWidth:L,labelHeight:P,textHeight:N,type:"default",position:C.labelPosition||Ie.labelPosition,labelAngle:(w=C.labelAngle)!==null&&w!==void 0?w:0,backdropColor:Le,backdropShadowColor:nt,backdropShadowBlur:St,backdropPadding:At,backdropBorderColor:Po,backdropBorderWidth:Fo,backdropCornerRadius:Io,backdropLabelPadding:No,backdropArea:Go,labelBoxOffset:[M,H]};i.processBackdrop(y,Mo)}i.invalidateBuffers(),i.render(t)}}},{key:"renderLabelBackgrounds",value:function(t,e){var r=this.internals,i=r.labelBackgroundProgram,o=r.nodeDataCache,s=r.nodeDataTexture,l=ue.nodeLabel.writesPickingThisFrame(this.internals),u=[],d=z(this.displayedNodeLabels),h;try{for(d.s();!(h=d.n()).done;){var c=h.value,f=o[c];!f||f.visibility==="hidden"||e&&f.labelDepth!==e||!l&&!f.labelBackgroundColor||u.push(c)}}catch(I){d.e(I)}finally{d.f()}if(u.length!==0){i.reallocate(u.length);for(var g=0;g<u.length;g++){var m,p,v,y,b=u[g],T=o[b],x=(m=s?.getIndex(b))!==null&&m!==void 0?m:-1;if(!(x<0)){var _=this.measureNodeLabel(T),S=_.width,A=_.height,R=_.textHeight,w=et(this.internals.pickingState,"nodeLabel",b)||et(this.internals.pickingState,"node",b),F=T.labelBackgroundColor?xe(T.labelBackgroundColor):xe("transparent"),D={nodeIndex:x,id:dt(w),color:F,labelWidth:S,labelHeight:A,textHeight:R,positionMode:(p=pt[T.labelPosition||Ie.labelPosition])!==null&&p!==void 0?p:0,labelAngle:(v=T.labelAngle)!==null&&v!==void 0?v:0,padding:(y=T.labelBackgroundPadding)!==null&&y!==void 0?y:ya};i.processLabelBackground(g,D)}}i.invalidateBuffers(),i.render(t)}}},{key:"cacheAttachments",value:function(t){var e=this.internals,r=e.attachmentManager,i=e.pixelRatio,o=e.nodeDataCache,s=e.nodesWithBackdrop,l=e.graph;if(r){var u=z(s),d;try{for(u.s();!(d=u.n()).done;){var h=d.value;if(this.displayedNodeLabels.has(h)){var c=o[h];if(!(!c||c.visibility==="hidden")&&!(t&&c.depth!==t)&&c.labelAttachment){var f=l.getNodeAttributes(h),g=this.measureNodeLabel(c),m=g.width,p=g.height,v={node:h,attributes:f,pixelRatio:i,labelWidth:m,labelHeight:p};r.renderAttachment(h,c.labelAttachment,v)}}}}catch(y){u.e(y)}finally{u.f()}r.regenerateAtlas()}}},{key:"renderAttachments",value:function(t,e){var r=this.internals,i=r.attachmentManager,o=r.attachmentProgram,s=r.nodeDataCache,l=r.nodesWithBackdrop,u=r.pixelRatio,d=r.nodeDataTexture;if(!(!i||!o)){var h=0;o.reallocateAttachments(l.size);var c=z(l),f;try{for(c.s();!(f=c.n()).done;){var g,m,p,v,y=f.value;if(this.displayedNodeLabels.has(y)){var b=s[y];if(!(!b||b.visibility==="hidden")&&!(e&&b.labelDepth!==e)&&b.labelAttachment){var T=i.getEntry(y,b.labelAttachment);if(T){var x=(g=d?.getIndex(y))!==null&&g!==void 0?g:-1;if(!(x<0)){var _=this.measureNodeLabel(b),S=_.width,A=_.height,R=_.textHeight,w=(m=hi[b.labelAttachmentPlacement||"below"])!==null&&m!==void 0?m:0;o.processAttachment(h,{nodeIndex:x,atlasX:T.x,atlasY:T.y,atlasW:T.width,atlasH:T.height,attachWidth:T.width/u,attachHeight:T.height/u,positionMode:(p=pt[b.labelPosition||Ie.labelPosition])!==null&&p!==void 0?p:0,attachmentPlacement:w,labelWidth:S,labelHeight:A,textHeight:R,labelAngle:(v=b.labelAngle)!==null&&v!==void 0?v:0}),h++}}}}}}catch(F){c.e(F)}finally{c.f()}h!==0&&(o.reallocateAttachments(h),i.bindTexture(Ot),o.invalidateBuffers(),o.render(t))}}},{key:"computeDisplayedEdgeLabels",value:function(){var t=this.internals,e=t.graph,r=t.stateManager,i=t.settings,o=t.edgesWithForcedLabels,s=r.getHighlightedNodes(),l=i.edgeLabelAnchors==="allNodes"?new Set(this.edgeAnchorGrid.getLabelsToDisplay(this.internals.getCameraState().ratio,i.labelDensity)):this.displayedNodeLabels,u=r.hovered,d=bh({graph:e,hoveredNode:u?.kind==="node"?u.key:null,displayedNodeLabels:l,highlightedNodes:s});la(d,o),this.edgeLabelCandidates=d,this.displayedEdgeLabels=new Set}},{key:"filterEdgeLabelsForDepth",value:function(t){for(var e=this.internals,r=e.graph,i=e.nodeDataCache,o=e.edgeDataCache,s=[],l=new Set,u=0,d=this.edgeLabelCandidates.length;u<d;u++){var h=this.edgeLabelCandidates[u];if(!l.has(h)){l.add(h);var c=r.extremities(h),f=i[c[0]],g=i[c[1]],m=o[h];!m||!f||!g||m.visibility==="hidden"||m.labelVisibility==="hidden"||f.visibility==="hidden"||g.visibility==="hidden"||t&&m.labelDepth!==t||m.label&&s.push(h)}}return s}},{key:"renderEdgeLabels",value:function(t,e){var r=this.internals,i=r.graph,o=r.nodeDataCache,s=r.edgeDataCache,l=r.primitives,u=r.edgeLabelProgram,d=r.nodeDataTexture,h=r.edgeDataTexture;if(u){var c=this.filterEdgeLabelsForDepth(e),f=z(c),g;try{for(f.s();!(g=f.n()).done;){var m=g.value;this.displayedEdgeLabels.add(m)}}catch(X){f.e(X)}finally{f.f()}if(c.length!==0){if(this.labelsDirty){var p,v,y=0,b=z(c),T;try{for(b.s();!(T=b.n()).done;){var x=T.value;y+=s[x].label.length}}catch(X){b.e(X)}finally{b.f()}u.reallocate(y);var _=(p=l==null||(v=l.edges)===null||v===void 0||(v=v.label)===null||v===void 0?void 0:v.margin)!==null&&p!==void 0?p:5,S="over",A=0,R=z(c),w;try{for(R.s();!(w=R.n()).done;){var F,D,I=w.value,C=i.extremities(I),k=C[0],G=C[1],N=o[k],L=o[G],P=s[I],M=d.getIndex(k),H=d.getIndex(G),O=h.getIndex(I),q={text:P.label,x:(N.x+L.x)/2,y:(N.y+L.y)/2,size:Xi,color:P.labelColor,nodeSize:0,nodeIndex:-1,margin:_,position:(F=P.labelPosition)!==null&&F!==void 0?F:S,hidden:!1,forceLabel:We(P),type:"default",zIndex:(D=P.zIndex)!==null&&D!==void 0?D:0,parentType:"edge",parentKey:I,fontKey:"",labelAngle:0,sourceX:N.x,sourceY:N.y,targetX:L.x,targetY:L.y,sourceSize:N.size,targetSize:L.size,sourceShape:N.shape||"circle",targetShape:L.shape||"circle",edgeSize:P.size,offset:0,edgeAttributes:P,sourceNodeIndex:M,targetNodeIndex:H,edgeIndex:O},j=u.processEdgeLabel(I,A,q);A+=j}}catch(X){R.e(X)}finally{R.f()}u.invalidateBuffers()}u.render(t)}}}},{key:"renderEdgeLabelBackgrounds",value:function(t,e){var r,i,o=this.internals,s=o.edgeLabelBackgroundProgram,l=o.edgeLabelProgram,u=o.edgeDataCache,d=o.primitives,h=o.edgeDataTexture;if(!(!h||!l||!s)){var c=ue.edgeLabel.writesPickingThisFrame(this.internals),f=(r=d==null||(i=d.edges)===null||i===void 0||(i=i.label)===null||i===void 0?void 0:i.margin)!==null&&r!==void 0?r:5,g="over",m=this.filterEdgeLabelsForDepth(e),p=[],v=z(m),y;try{for(v.s();!(y=v.n()).done;){var b=y.value;!c&&!u[b].labelBackgroundColor||p.push(b)}}catch(N){v.e(N)}finally{v.f()}if(p.length!==0){s.reallocate(p.length);for(var T=0;T<p.length;T++){var x,_,S,A=p[T],R=u[A],w=R.label,F=l.measureLabelAtlasWidth(w),D=(x=R.labelPosition)!==null&&x!==void 0?x:g,I=typeof D=="string"&&(_=_h[D])!==null&&_!==void 0?_:0,C=et(this.internals.pickingState,"edgeLabel",A)||et(this.internals.pickingState,"edge",A),k=R.labelBackgroundColor?xe(R.labelBackgroundColor):xe("transparent"),G={edgeIndex:h.getIndex(A),baseFontSize:Xi,totalTextWidth:F,positionMode:I,margin:f,padding:(S=R.labelBackgroundPadding)!==null&&S!==void 0?S:Th,color:k,id:dt(C),edgeAttributes:R};s.processEdgeLabelBackground(T,A,G)}s.invalidateBuffers(),s.render(t)}}}}])}(),Sh=function(){function n(a,t,e,r){Y(this,n),E(this,"nodeStates",new Map),E(this,"edgeStates",new Map),E(this,"hovered",null),E(this,"dirtyNodes",new Set),E(this,"dirtyEdges",new Set),E(this,"graphStateChanged",!1),E(this,"graphStateFlagsDirty",!1),this.scheduleRefresh=a,this.customNodeStateDefaults=t,this.customEdgeStateDefaults=e,this.customGraphStateDefaults=r,this.graphState=ta(r)}return K(n,[{key:"getNodeState",value:function(t){t=""+t;var e=this.nodeStates.get(t);return e||(e=Nr(this.customNodeStateDefaults),this.nodeStates.set(t,e)),e}},{key:"getEdgeState",value:function(t){t=""+t;var e=this.edgeStates.get(t);return e||(e=Gr(this.customEdgeStateDefaults),this.edgeStates.set(t,e)),e}},{key:"getGraphState",value:function(){return this.flushGraphStateFlags(),this.graphState}},{key:"getHighlightedNodes",value:function(){var t=new Set,e=z(this.nodeStates),r;try{for(e.s();!(r=e.n()).done;){var i=Q(r.value,2),o=i[0],s=i[1];s.isHighlighted&&t.add(o)}}catch(l){e.e(l)}finally{e.f()}return t}},{key:"setNodeState",value:function(t,e){t=""+t;var r=this.getNodeState(t);if(ft(r,e)){var i=W(W({},r),e);this.nodeStates.set(t,i),this.dirtyNodes.add(t),this.updateHoveredNodeTracking(t,r,i),this.graphStateFlagsDirty=!0,this.scheduleRefresh()}}},{key:"setEdgeState",value:function(t,e){t=""+t;var r=this.getEdgeState(t);if(ft(r,e)){var i=W(W({},r),e);this.edgeStates.set(t,i),this.dirtyEdges.add(t),this.updateHoveredEdgeTracking(t,r,i),this.graphStateFlagsDirty=!0,this.scheduleRefresh()}}},{key:"setGraphState",value:function(t){if(ft(this.graphState,t)){var e=W(W({},this.graphState),t);e.isIdle=!e.isPanning&&!e.isZooming&&!e.isDragging,this.graphState=e,this.graphStateChanged=!0,this.scheduleRefresh()}}},{key:"setNodesState",value:function(t,e){var r=!1,i=z(t),o;try{for(i.s();!(o=i.n()).done;){var s=o.value;s=""+s;var l=this.getNodeState(s);if(ft(l,e)){var u=W(W({},l),e);this.nodeStates.set(s,u),this.dirtyNodes.add(s),this.updateHoveredNodeTracking(s,l,u),r=!0}}}catch(d){i.e(d)}finally{i.f()}r&&(this.graphStateFlagsDirty=!0,this.scheduleRefresh())}},{key:"setEdgesState",value:function(t,e){var r=!1,i=z(t),o;try{for(i.s();!(o=i.n()).done;){var s=o.value;s=""+s;var l=this.getEdgeState(s);if(ft(l,e)){var u=W(W({},l),e);this.edgeStates.set(s,u),this.dirtyEdges.add(s),this.updateHoveredEdgeTracking(s,l,u),r=!0}}}catch(d){i.e(d)}finally{i.f()}r&&(this.graphStateFlagsDirty=!0,this.scheduleRefresh())}},{key:"removeNode",value:function(t){this.nodeStates.delete(t),this.dirtyNodes.delete(t),this.clearHoveredFor("node",t)}},{key:"removeEdge",value:function(t){this.edgeStates.delete(t),this.dirtyEdges.delete(t),this.clearHoveredFor("edge",t)}},{key:"pruneNodes",value:function(t){var e=z(this.nodeStates.keys()),r;try{for(e.s();!(r=e.n()).done;){var i=r.value;t(i)||this.removeNode(i)}}catch(o){e.e(o)}finally{e.f()}}},{key:"pruneEdges",value:function(t){var e=z(this.edgeStates.keys()),r;try{for(e.s();!(r=e.n()).done;){var i=r.value;t(i)||this.removeEdge(i)}}catch(o){e.e(o)}finally{e.f()}}},{key:"clearNodes",value:function(){this.nodeStates.clear(),this.dirtyNodes.clear(),this.clearHoveredForKinds(ka("node"))}},{key:"clearEdges",value:function(){this.edgeStates.clear(),this.dirtyEdges.clear(),this.clearHoveredForKinds(ka("edge"))}},{key:"resetGraphState",value:function(){this.graphState=ta(this.customGraphStateDefaults),this.graphStateChanged=!1,this.graphStateFlagsDirty=!1}},{key:"clearDirtyTracking",value:function(){this.dirtyNodes.clear(),this.dirtyEdges.clear(),this.graphStateChanged=!1}},{key:"setHovered",value:function(t){this.hovered=t}},{key:"clearHoveredFor",value:function(t,e){this.hovered&&this.hovered.key===e&&ka(t).includes(this.hovered.kind)&&(this.hovered=null)}},{key:"clearHoveredForKinds",value:function(t){this.hovered&&t.includes(this.hovered.kind)&&(this.hovered=null)}},{key:"updateGraphStateFromNodes",value:function(){var t,e=!1,r=!1,i=!1,o=z(this.nodeStates),s;try{for(o.s();!(s=o.n()).done;){var l=Q(s.value,2),u=l[1];if(u.isHovered&&(e=!0),u.isHighlighted&&(r=!0),u.isDragged&&(i=!0),e&&r&&i)break}}catch(h){o.e(h)}finally{o.f()}!e&&((t=this.hovered)===null||t===void 0?void 0:t.kind)==="edge"&&(e=!0);var d=!this.graphState.isPanning&&!this.graphState.isZooming&&!i;(this.graphState.hasHovered!==e||this.graphState.hasHighlighted!==r||this.graphState.isDragging!==i||this.graphState.isIdle!==d)&&(this.graphStateChanged=!0),this.graphState=W(W({},this.graphState),{},{hasHovered:e,hasHighlighted:r,isDragging:i,isIdle:d})}},{key:"updateGraphStateFromEdges",value:function(){var t,e=((t=this.hovered)===null||t===void 0?void 0:t.kind)==="node";if(!e){var r=z(this.edgeStates),i;try{for(r.s();!(i=r.n()).done;){var o=Q(i.value,2),s=o[1];if(s.isHovered){e=!0;break}}}catch(l){r.e(l)}finally{r.f()}}this.graphState.hasHovered!==e&&(this.graphStateChanged=!0),this.graphState=W(W({},this.graphState),{},{hasHovered:e})}},{key:"flushGraphStateFlags",value:function(){this.graphStateFlagsDirty&&(this.updateGraphStateFromNodes(),this.updateGraphStateFromEdges(),this.graphStateFlagsDirty=!1)}},{key:"updateHoveredNodeTracking",value:function(t,e,r){var i;if(e.isHovered!==r.isHovered)if(r.isHovered){var o;if(((o=this.hovered)===null||o===void 0?void 0:o.kind)==="node"&&this.hovered.key!==t){var s=this.hovered.key,l=this.getNodeState(s);this.nodeStates.set(s,W(W({},l),{},{isHovered:!1})),this.dirtyNodes.add(s)}this.hovered={kind:"node",key:t}}else((i=this.hovered)===null||i===void 0?void 0:i.kind)==="node"&&this.hovered.key===t&&(this.hovered=null)}},{key:"updateHoveredEdgeTracking",value:function(t,e,r){var i;if(e.isHovered!==r.isHovered)if(r.isHovered){var o;if(((o=this.hovered)===null||o===void 0?void 0:o.kind)==="edge"&&this.hovered.key!==t){var s=this.hovered.key,l=this.getEdgeState(s);this.edgeStates.set(s,W(W({},l),{},{isHovered:!1})),this.dirtyEdges.add(s)}this.hovered={kind:"edge",key:t}}else((i=this.hovered)===null||i===void 0?void 0:i.kind)==="edge"&&this.hovered.key===t&&(this.hovered=null)}}])}(),qi=1,Yi=2,Ki=3,Zi=4,Ah=function(n){function a(t,e){var r,i,o,s,l,u=arguments.length>2&&arguments[2]!==void 0?arguments[2]:{};Y(this,a),l=te(this,a),E(l,"nodeReducer",null),E(l,"edgeReducer",null),E(l,"stageCanvas",null),E(l,"mouseLayer",null),E(l,"gestureHint",null),E(l,"extraElements",{}),E(l,"webGLContext",null),E(l,"pickingFrameBuffer",null),E(l,"pickingTexture",null),E(l,"pickingDepthBuffer",null),E(l,"activeListeners",{}),E(l,"nodeVariableEntries",[]),E(l,"edgeVariableEntries",[]),E(l,"edgePathsByName",new Map),E(l,"nodeProgramIndex",{}),E(l,"edgeProgramIndex",{}),E(l,"edgeTextureIndexCache",{}),E(l,"nodeGraphCoords",{}),E(l,"nodeExtent",{x:[0,1],y:[0,1]}),E(l,"matrix",be()),E(l,"invMatrix",be()),E(l,"correctionRatio",1),E(l,"frameId",0),E(l,"customBBox",null),E(l,"gpuTimerExt",void 0),E(l,"activeGpuTimerQuery",null),E(l,"pendingGpuTimerQueries",[]),E(l,"normalizationFunction",yn({x:[0,1],y:[0,1]})),E(l,"graphToViewportRatio",1),E(l,"pickingState",Jd()),E(l,"prevNodeVisibilities",{}),E(l,"width",0),E(l,"height",0),E(l,"autoRescaleFrozen",!1),E(l,"stylesDeclaration",null),E(l,"resolvedStageStyle",{}),E(l,"renderFrame",null),E(l,"contextLost",!1),E(l,"pendingProcess","full"),E(l,"needToRefreshState",!1),E(l,"checkEdgesEventsFrame",null),E(l,"edgeStyleAnalysis",{dependency:"static",xAttribute:null,yAttribute:null}),E(l,"depthLayers",$(hn)),E(l,"customLayerPrograms",new Map),E(l,"nodeShapeSlug",null),E(l,"sdfAtlas",null),E(l,"depthRanges",{nodes:{},edges:{}}),E(l,"nodeBaseDepth",{}),E(l,"edgeBaseDepth",{});var d=u.primitives,h=u.styles,c=u.settings,f=c===void 0?{}:c,g=u.nodeReducer,m=u.edgeReducer,p=u.customNodeState,v=u.customEdgeState,y=u.customGraphState;l.stateManager=new Sh(function(){return l.scheduleStateRefresh()},p,v,y);var b=d??Wr;l.stylesDeclaration=h?{nodes:(r=h.nodes)!==null&&r!==void 0?r:gn.nodes,edges:(i=h.edges)!==null&&i!==void 0?i:gn.edges,stage:h.stage}:gn,l.nodeReducer=g??null,l.edgeReducer=m??null;var T=na(l.stylesDeclaration.nodes);l.nodeReducer&&(T.dependency="graph-state"),l.edgeStyleAnalysis=na(l.stylesDeclaration.edges),l.edgeReducer&&(l.edgeStyleAnalysis.dependency="graph-state"),l.stylesDeclaration.stage&&(l.resolvedStageStyle=sa(l.stylesDeclaration.stage,l.stateManager.graphState));var x=jr(f);if(xn(x),x.enableNodeDrag){var _=T.xAttribute,S=T.yAttribute;if((!_||!S)&&!x.dragPositionToAttributes)throw new Error('Sigma: `enableNodeDrag` is true but position attribute names could not be inferred from styles. Either use attribute bindings for x/y in your node styles (e.g. `x: { attribute: "x" }`), or provide a `dragPositionToAttributes` setting.')}if(Vr(t),!(e instanceof HTMLElement))throw new Error("Sigma: container should be an html element.");l.container=e,l.edgeGroups=new Qd(t,function(L,P){for(var M=0;M<L.length;M++){var H=l.stateManager.getEdgeState(L[M]);H.parallelIndex=M,H.parallelCount=P}});var A=new Zd(t,l.viewportToGraph.bind(l),l.setNodesState.bind(l),function(L,P){return l.emit(L,P)});if(l.depthLayers=(o=b.depthLayers)!==null&&o!==void 0?o:$(hn),!(h!=null&&h.nodes)&&!un.every(function(L){return l.depthLayers.includes(L)}))throw new Error("Sigma: depthLayers must include ".concat(un.join(", ")," for the built-in node styles."));if(!(h!=null&&h.edges)&&!dn.every(function(L){return l.depthLayers.includes(L)}))throw new Error("Sigma: depthLayers must include ".concat(dn.join(", ")," for the built-in edge styles."));l.itemBuckets={nodes:new Da(l.depthLayers),edges:new Da(l.depthLayers)},l.initWebGLContext(),l.mouseLayer=gt("div",{position:"absolute",touchAction:"none",userSelect:"none"},{class:"sigma-mouse"}),l.container.appendChild(l.mouseLayer),l.resolvedStageStyle.background&&(l.container.style.backgroundColor=l.resolvedStageStyle.background),l.resolvedStageStyle.cursor&&(l.container.style.cursor=l.resolvedStageStyle.cursor);var R=new Fi(l.webGLContext),w=new Ra(l.webGLContext,{channels:1}),F=new Ii(l.webGLContext),D=new Ra(l.webGLContext,{channels:4}),I=l.webGLContext,C=new yh({gl:I,getFrameBuffer:function(){return l.pickingFrameBuffer},getPixelRatio:function(){return l.internals.pixelRatio},getDownSizingRatio:function(){return l.internals.settings.pickingDownSizingRatio},isRenderPending:function(){return l.renderFrame!==null},onIndex:function(P,M){var H;return to(l.internals,(H=l.pickingState.lookup[P])!==null&&H!==void 0?H:null,M)}}),k=l.initPrograms(b,x),G=b==null||(s=b.nodes)===null||s===void 0?void 0:s.labelAttachments,N=null;return G&&Object.keys(G).length>0&&(N=new Pi(I,G,function(){return l.scheduleRender()})),l.internals=W(W({nodeDataCache:{},edgeDataCache:{},nodesWithForcedLabels:new Set,nodesWithBackdrop:new Set,edgesWithForcedLabels:new Set,settings:x,primitives:b,pixelRatio:Nt(),graph:t,stateManager:l.stateManager,dragManager:A,hoverResolver:C,nodeStyleAnalysis:T,pickingState:l.pickingState},k),{},{attachmentManager:N,nodeDataTexture:R,nodeFrameTexture:w,edgeDataTexture:F,edgeFrameTexture:D,getDimensions:function(){return l.getDimensions()},getGraphDimensions:function(){return l.getGraphDimensions()},getStagePadding:function(){return l.getStagePadding()},getCameraState:function(){return l.camera.getState()},getHitAtPosition:function(P){return l.getHitAtPosition(P)},setNodeState:function(P,M){return l.setNodeState(P,M)},setEdgeState:function(P,M){return l.setEdgeState(P,M)},updateContainerCursor:function(){return l.updateContainerCursor()},scheduleRefresh:function(){return l.scheduleRefresh()},viewportToFramedGraph:function(P){return l.viewportToFramedGraph(P)},viewportToGraph:function(P){return l.viewportToGraph(P)},framedGraphToViewport:function(P){return l.framedGraphToViewport(P)},scaleSize:function(P){return l.scaleSize(P)},emit:function(P,M){return l.emit(P,M)}}),l.labelRenderer=new Eh(l.internals),l.resize(),l.initializeWebGLLabels(),l.camera=new Mi,l.bindCameraHandlers(),l.mouseCaptor=new Xd(l.mouseLayer,l),l.mouseCaptor.setSettings(l.internals.settings),l.touchCaptor=new Kd(l.mouseLayer,l),l.touchCaptor.setSettings(l.internals.settings),l.bindEventHandlers(),l.bindGraphHandlers(),l.handleSettingsUpdate(),l.refresh(),l}return ne(a,n),K(a,[{key:"initializeWebGLLabels",value:function(){this.sdfAtlas=new Ye,this.sdfAtlas.registerFont({family:"sans-serif",weight:"normal",style:"normal"})}},{key:"resetWebGLTexture",value:function(){var e=this.webGLContext;if(!this.pickingFrameBuffer)return this;var r=Math.ceil(this.width*this.internals.pixelRatio/this.internals.settings.pickingDownSizingRatio),i=Math.ceil(this.height*this.internals.pixelRatio/this.internals.settings.pickingDownSizingRatio);e.bindFramebuffer(e.FRAMEBUFFER,this.pickingFrameBuffer),this.pickingTexture&&e.deleteTexture(this.pickingTexture);var o=e.createTexture();o&&(e.bindTexture(e.TEXTURE_2D,o),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,r,i,0,e.RGBA,e.UNSIGNED_BYTE,null),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,o,0),this.pickingTexture=o),this.pickingDepthBuffer&&e.deleteRenderbuffer(this.pickingDepthBuffer);var s=e.createRenderbuffer();return s&&(e.bindRenderbuffer(e.RENDERBUFFER,s),e.renderbufferStorage(e.RENDERBUFFER,e.DEPTH_COMPONENT16,r,i),e.framebufferRenderbuffer(e.FRAMEBUFFER,e.DEPTH_ATTACHMENT,e.RENDERBUFFER,s),this.pickingDepthBuffer=s),e.bindFramebuffer(e.FRAMEBUFFER,null),this}},{key:"bindCameraHandlers",value:function(){var e=this;return this.activeListeners.camera=function(){e.refreshMatrices(),e.labelRenderer.labelsDirty=!0,e.scheduleRender()},this.activeListeners.cameraAnimationStart=function(r){var i=r.from,o=r.to;i.ratio!==o.ratio&&e.stateManager.setGraphState({isZooming:!0})},this.activeListeners.cameraAnimationEnd=function(){e.stateManager.setGraphState({isZooming:!1})},this.camera.on("updated",this.activeListeners.camera),this.camera.on("animationStart",this.activeListeners.cameraAnimationStart),this.camera.on("animationEnd",this.activeListeners.cameraAnimationEnd),this}},{key:"unbindCameraHandlers",value:function(){return this.camera.removeListener("updated",this.activeListeners.camera),this.camera.removeListener("animationStart",this.activeListeners.cameraAnimationStart),this.camera.removeListener("animationEnd",this.activeListeners.cameraAnimationEnd),this}},{key:"getHitAtPosition",value:function(e){var r;if(this.contextLost)return null;var i=this.webGLContext;i.bindFramebuffer(i.FRAMEBUFFER,this.pickingFrameBuffer);var o=vr(i,this.pickingFrameBuffer,e.x,e.y,this.internals.pixelRatio,this.internals.settings.pickingDownSizingRatio),s=Kn.apply(void 0,$(o));return(r=this.pickingState.lookup[s])!==null&&r!==void 0?r:null}},{key:"bindEventHandlers",value:function(){return oh(this.internals,this.mouseCaptor,this.touchCaptor,this.activeListeners),this}},{key:"bindGraphHandlers",value:function(){return sh({graph:this.internals.graph,edgeGroups:this.edgeGroups,addNode:this.addNode.bind(this),updateNode:this.updateNode.bind(this),removeNode:this.removeNode.bind(this),addEdge:this.addEdge.bind(this),updateEdge:this.updateEdge.bind(this),removeEdge:this.removeEdge.bind(this),clearEdgeState:this.clearEdgeState.bind(this),clearNodeState:this.clearNodeState.bind(this),clearEdgeIndices:this.clearEdgeIndices.bind(this),clearNodeIndices:this.clearNodeIndices.bind(this),refresh:this.refresh.bind(this)},this.activeListeners),this}},{key:"unbindGraphHandlers",value:function(){lh(this.internals.graph,this.activeListeners)}},{key:"getNodeShapeId",value:function(e){return this.internals.nodeShapeMap&&this.internals.nodeGlobalShapeIds&&e.shape&&e.shape in this.internals.nodeShapeMap?this.internals.nodeGlobalShapeIds[this.internals.nodeShapeMap[e.shape]]:Bt(e.shape||"circle")}},{key:"processNodes",value:function(){var e=this,r=this.internals.graph,i=this.internals.settings,o=this.getDimensions(),s=i.autoRescale,l=i.autoRescaleContent,u=this.nodeExtent;if(s===!1){var d=o.width,h=o.height;u={x:[-d/2,d/2],y:[-h/2,h/2]}}else(s!=="once"||!this.autoRescaleFrozen)&&(u=this.computeNodeExtent(),l!=="positions"&&!this.customBBox&&(u=ch({extent:u,coords:this.nodeGraphCoords,nodeData:this.internals.nodeDataCache,dimensions:o,stagePadding:this.getStagePadding(),zoomToSizeRatioFunction:i.zoomToSizeRatioFunction,itemSizesReference:i.itemSizesReference,fitLabels:l==="labels",nodeLabelBox:function(H,O){return e.labelRenderer.nodeLabelBox(H,O)}})),s==="once"&&(this.autoRescaleFrozen=!0));this.nodeExtent=u,this.normalizationFunction=yn(this.customBBox||this.nodeExtent);var c=new Mi,f=Me(c.getState(),o,this.getGraphDimensions(),this.getStagePadding());this.labelRenderer.labelGrid.resizeAndClear(o,i.labelGridCellSize),this.labelRenderer.edgeAnchorGrid.resizeAndClear(o,i.labelGridCellSize);var g=i.renderEdgeLabels&&i.edgeLabelAnchors==="allNodes",m=!1;La(this.pickingState,"node");for(var p=r.nodes(),v=0,y=p.length;v<y;v++){var b=p[v],T=this.internals.nodeDataCache[b],x=this.nodeGraphCoords[b];T.x=x.x,T.y=x.y,this.normalizationFunction.applyTo(T),T.visibility!==this.prevNodeVisibilities[b]&&(m=!0),typeof T.label=="string"&&T.visibility!=="hidden"&&T.labelVisibility!=="hidden"&&this.labelRenderer.labelGrid.add(b,T.size,this.framedGraphToViewport(T,{matrix:f})),g&&T.visibility!=="hidden"&&this.labelRenderer.edgeAnchorGrid.add(b,T.size,this.framedGraphToViewport(T,{matrix:f}))}this.labelRenderer.labelGrid.organize(),this.labelRenderer.edgeAnchorGrid.organize(),this.nodeProgram.reallocate(p.length);var _=0;this.depthRanges.nodes={},this.nodeBaseDepth={};var S=this.internals.nodeDataCache,A=z(this.depthLayers),R;try{for(A.s();!(R=A.n()).done;){var w=R.value,F=this.itemBuckets.nodes.getSorted(w,function(M){return S[M].zIndex});if(F.length!==0){this.depthRanges.nodes[w]=[{offset:_,count:F.length}];var D=z(F),I;try{for(D.s();!(I=D.n()).done;){var C=I.value;this.nodeBaseDepth[C]=w,this.nodeProgram.allocateNode(C),Oi(this.pickingState,"node",C),this.addNodeToProgram(C,_++)}}catch(M){D.e(M)}finally{D.f()}}}}catch(M){A.e(M)}finally{A.f()}this.nodeProgram.invalidateBuffers();for(var k=0,G=p.length;k<G;k++)this.prevNodeVisibilities[p[k]]=this.internals.nodeDataCache[p[k]].visibility;this.labelRenderer.processWebGLLabels(p);var N=z(this.customLayerPrograms.values()),L;try{for(N.s();!(L=N.n()).done;){var P=L.value.program;P.cacheData&&P.cacheData()}}catch(M){N.e(M)}finally{N.f()}return m}},{key:"processEdges",value:function(){var e=this.internals.graph,r=e.edges();this.edgeProgram.reallocate(r.length);var i=0;La(this.pickingState,"edge"),this.depthRanges.edges={},this.edgeBaseDepth={};var o=this.internals.edgeDataCache,s=z(this.depthLayers),l;try{for(s.s();!(l=s.n()).done;){var u=l.value,d=this.itemBuckets.edges.getSorted(u,function(g){return o[g].zIndex});if(d.length!==0){this.depthRanges.edges[u]=[{offset:i,count:d.length}];var h=z(d),c;try{for(h.s();!(c=h.n()).done;){var f=c.value;this.edgeBaseDepth[f]=u,Oi(this.pickingState,"edge",f),this.addEdgeToProgram(f,i++)}}catch(g){h.e(g)}finally{h.f()}}}}catch(g){s.e(g)}finally{s.f()}this.edgeProgram.invalidateBuffers()}},{key:"updateNodeDepthRanges",value:function(e,r,i){var o=this.nodeProgramIndex[e];o!==void 0&&(da(this.depthRanges.nodes,r,o),ha(this.depthRanges.nodes,i,o))}},{key:"updateEdgeDepthRanges",value:function(e,r,i){var o=this.edgeProgramIndex[e];o!==void 0&&(da(this.depthRanges.edges,r,o),ha(this.depthRanges.edges,i,o))}},{key:"handleSettingsUpdate",value:function(){var e=this,r=this.internals.settings;return this.camera.minRatio=r.minCameraRatio,this.camera.maxRatio=r.maxCameraRatio,this.camera.enabledZooming=r.enableCameraZooming,this.camera.enabledPanning=r.enableCameraPanning,this.camera.enabledRotation=r.enableCameraRotation,r.cameraPanBoundaries?this.camera.constrainState=function(i){return e.cleanCameraState(i,r.cameraPanBoundaries&&Z(r.cameraPanBoundaries)==="object"?r.cameraPanBoundaries:{})}:this.camera.constrainState=null,this.camera.setState(this.camera.getState()),this.mouseLayer.style.touchAction=r.gestureTarget==="graph"?"none":r.gestureTarget==="shared"?"pan-x pan-y":"auto",r.gestureTarget!=="shared"&&this.gestureHint&&(this.gestureHint.kill(),this.gestureHint=null),this.mouseCaptor.setSettings(this.internals.settings),this.touchCaptor.setSettings(this.internals.settings),this}},{key:"cleanCameraState",value:function(e){var r=arguments.length>1&&arguments[1]!==void 0?arguments[1]:{},i=r.tolerance,o=i===void 0?0:i,s=r.boundaries,l=W({},e),u=s||this.nodeExtent,d=Q(u.x,2),h=d[0],c=d[1],f=Q(u.y,2),g=f[0],m=f[1],p=[this.graphToViewport({x:h,y:g},{cameraState:e}),this.graphToViewport({x:c,y:g},{cameraState:e}),this.graphToViewport({x:h,y:m},{cameraState:e}),this.graphToViewport({x:c,y:m},{cameraState:e})],v=1/0,y=-1/0,b=1/0,T=-1/0;p.forEach(function(C){var k=C.x,G=C.y;v=Math.min(v,k),y=Math.max(y,k),b=Math.min(b,G),T=Math.max(T,G)});var x=y-v,_=T-b,S=this.getDimensions(),A=S.width,R=S.height,w=0,F=0;if(x>=A?y<A-o?w=y-(A-o):v>o&&(w=v-o):y>A+o?w=y-(A+o):v<-o&&(w=v+o),_>=R?T<R-o?F=T-(R-o):b>o&&(F=b-o):T>R+o?F=T-(R+o):b<-o&&(F=b+o),w||F){var D=this.viewportToFramedGraph({x:0,y:0},{cameraState:e}),I=this.viewportToFramedGraph({x:w,y:F},{cameraState:e});w=I.x-D.x,F=I.y-D.y,l.x+=w,l.y+=F}return l}},{key:"refreshMatrices",value:function(){var e=this.camera.getState(),r=this.getDimensions(),i=this.getGraphDimensions(),o=this.getStagePadding();this.matrix=Me(e,r,i,o),this.invMatrix=Me(e,r,i,o,!0),this.correctionRatio=hr(this.matrix,e,r),this.graphToViewportRatio=this.getGraphToViewportRatio()}},{key:"processData",value:function(){var e;this.emit("beforeProcess"),(e=this.internals.attachmentManager)===null||e===void 0||e.clear();var r=W({},this.pickingState.idsByKind),i=this.processNodes();(this.pendingProcess==="full"||i)&&this.processEdges(),eh(this.pickingState,this.internals),th(r,this.pickingState.idsByKind)||this.internals.hoverResolver.invalidate(),this.pendingProcess="none",this.emit("afterProcess")}},{key:"render",value:function(){var e=this;if(this.contextLost)return this;this.emit("beforeRender");var r=function(){return e.internals.hoverResolver.frameRendered(),e.emit("afterRender"),e};if(this.renderFrame&&(cancelAnimationFrame(this.renderFrame),this.renderFrame=null),this.resize(),(this.pendingProcess!=="none"||this.needToRefreshState)&&(this.labelRenderer.labelsDirty=!0),this.pendingProcess!=="none"&&this.processData(),this.needToRefreshState&&this.refreshState(),this.needToRefreshState=!1,this.stateManager.clearDirtyTracking(),this.pendingProcess!=="none"&&this.processData(),this.clear(),this.resetWebGLTexture(),!this.internals.graph.order)return r();var i=this.mouseCaptor,o=this.camera.isAnimating()||i.isMoving||i.draggedEvents||i.currentWheelDirection;if(this.refreshMatrices(),this.frameId++,this.internals.settings.renderEdgeLabels&&!this.internals.edgeLabelProgram){var s=this.createEdgeLabelPrograms(),l=s.labelProgram,u=s.labelBackgroundProgram;this.internals.edgeLabelProgram=l,this.internals.edgeLabelBackgroundProgram=u}var d=this.internals.settings.DEBUG_logRenderStats?this.getDebugPrograms():null;d&&d.forEach(function(X){return X.resetDebugStats()}),this.internals.settings.DEBUG_gpuTimerQueries&&this.beginGpuTimerQuery(),this.internals.nodeFrameTexture.ensureCapacity(this.internals.nodeDataTexture.getCapacity()),this.internals.edgeFrameTexture.ensureCapacity(this.internals.edgeDataTexture.getCapacity());var h=this.getRenderParams(),c=ue.edge.writesPickingThisFrame(this.internals)?h:W(W({},h),{},{pickingFrameBuffer:null});this.labelRenderer.resetFrame();var f=this.webGLContext,g=Math.ceil(this.width*this.internals.pixelRatio/this.internals.settings.pickingDownSizingRatio),m=Math.ceil(this.height*this.internals.pixelRatio/this.internals.settings.pickingDownSizingRatio);if(f.bindFramebuffer(f.FRAMEBUFFER,this.pickingFrameBuffer),f.viewport(0,0,g,m),f.clear(f.COLOR_BUFFER_BIT|f.DEPTH_BUFFER_BIT),f.bindFramebuffer(f.FRAMEBUFFER,null),f.viewport(0,0,this.width*this.internals.pixelRatio,this.height*this.internals.pixelRatio),f.clear(f.COLOR_BUFFER_BIT|f.DEPTH_BUFFER_BIT),this.internals.nodeDataTexture.upload(),this.internals.edgeDataTexture.upload(),this.nodeProgram.uploadLayerTexture(),this.edgeProgram.uploadAttributeTexture(),this.emit("afterTexturesUpload"),this.internals.nodeDataTexture.bind(Ki),this.internals.edgeDataTexture.bind(Zi),this.edgeFramePass.run(h,this.internals.edgeFrameTexture,this.internals.edgeDataTexture.getHighWaterMark(),this.edgeProgram.getAttributeTexture(),this.nodeProgram.getAttributeTexture()),this.internals.edgeFrameTexture.bind(qi),this.internals.settings.renderLabels){this.labelRenderer.computeDisplayedNodeLabels();var p=this.labelRenderer.buildFramePassPoints(),v=p.data,y=p.count;this.nodeFramePass.run(v,y,this.internals.nodeFrameTexture,h,this.nodeProgram.getAttributeTexture()),this.internals.nodeFrameTexture.bind(Yi)}this.internals.settings.renderEdgeLabels&&this.labelRenderer.computeDisplayedEdgeLabels();var b=z(this.customLayerPrograms.values()),T;try{for(b.s();!(T=b.n()).done;){var x=T.value.program;x.preRender&&x.preRender(h)}}catch(X){b.e(X)}finally{b.f()}f.bindFramebuffer(f.FRAMEBUFFER,null),f.viewport(0,0,this.width*this.internals.pixelRatio,this.height*this.internals.pixelRatio),f.blendFunc(f.ONE,f.ONE_MINUS_SRC_ALPHA);var _=!this.internals.settings.hideLabelsOnMove||!o,S=z(this.depthLayers),A;try{for(S.s();!(A=S.n()).done;){var R=A.value,w=z(this.customLayerPrograms.values()),F;try{for(w.s();!(F=w.n()).done;){var D=F.value;D.depth===R&&D.program.render(h)}}catch(X){w.e(X)}finally{w.f()}var I=this.depthRanges.edges[R];if(I&&(!this.internals.settings.hideEdgesOnMove||!o)){var C=z(I),k;try{for(C.s();!(k=C.n()).done;){var G=k.value,N=G.offset,L=G.count;L>0&&this.edgeProgram.render(c,N,L)}}catch(X){C.e(X)}finally{C.f()}}this.internals.settings.renderEdgeLabels&&_&&(this.labelRenderer.renderEdgeLabelBackgrounds(ue.edgeLabel.writesPickingThisFrame(this.internals)?h:W(W({},h),{},{pickingFrameBuffer:null}),R),this.labelRenderer.renderEdgeLabels(h,R)),this.labelRenderer.cacheAttachments(R),this.labelRenderer.renderBackdrops(W(W({},h),{},{pickingFrameBuffer:null}),R);var P=this.depthRanges.nodes[R];if(P){var M=z(P),H;try{for(M.s();!(H=M.n()).done;){var O=H.value,q=O.offset,j=O.count;j>0&&this.nodeProgram.render(h,q,j)}}catch(X){M.e(X)}finally{M.f()}}_&&(this.labelRenderer.renderAttachments(W(W({},h),{},{pickingFrameBuffer:null}),R),this.labelRenderer.renderLabelBackgrounds(ue.nodeLabel.writesPickingThisFrame(this.internals)?h:W(W({},h),{},{pickingFrameBuffer:null}),R),this.internals.settings.renderLabels&&this.labelRenderer.renderWebGLLabels(h,R))}}catch(X){S.e(X)}finally{S.f()}return this.labelRenderer.labelsDirty=!1,this.internals.settings.DEBUG_displayPickingLayer&&(f.bindFramebuffer(f.READ_FRAMEBUFFER,this.pickingFrameBuffer),f.bindFramebuffer(f.DRAW_FRAMEBUFFER,null),f.blitFramebuffer(0,0,g,m,0,0,this.width*this.internals.pixelRatio,this.height*this.internals.pixelRatio,f.COLOR_BUFFER_BIT,f.NEAREST)),this.internals.settings.DEBUG_gpuTimerQueries&&this.endGpuTimerQuery(),this.pollGpuTimerQueries(),d&&this.logRenderStats(d),r()}},{key:"getDebugPrograms",value:function(){return[this.nodeProgram,this.edgeProgram,this.internals.labelProgram,this.internals.edgeLabelProgram,this.internals.edgeLabelBackgroundProgram,this.internals.backdropProgram,this.internals.labelBackgroundProgram,this.internals.attachmentProgram].filter(function(e){return e!==null})}},{key:"logRenderStats",value:function(e){var r={},i=z(e),o;try{for(i.s();!(o=i.n()).done;){var s=o.value;r[s.constructor.name]=W({},s.debugStats)}}catch(l){i.e(l)}finally{i.f()}console.log("[sigma] DEBUG_logRenderStats: frame #".concat(this.frameId)),console.table(r)}},{key:"getGpuTimerExtension",value:function(){return this.gpuTimerExt===void 0&&(this.gpuTimerExt=this.webGLContext.getExtension("EXT_disjoint_timer_query_webgl2"),this.gpuTimerExt||console.warn("Sigma: DEBUG_gpuTimerQueries is enabled, but this browser/driver doesn't support EXT_disjoint_timer_query_webgl2.")),this.gpuTimerExt}},{key:"beginGpuTimerQuery",value:function(){var e=this.getGpuTimerExtension();if(e){var r=this.webGLContext,i=r.createQuery();i&&(r.beginQuery(e.TIME_ELAPSED_EXT,i),this.activeGpuTimerQuery=i)}}},{key:"endGpuTimerQuery",value:function(){!this.gpuTimerExt||!this.activeGpuTimerQuery||(this.webGLContext.endQuery(this.gpuTimerExt.TIME_ELAPSED_EXT),this.pendingGpuTimerQueries.push({query:this.activeGpuTimerQuery,frameId:this.frameId}),this.activeGpuTimerQuery=null)}},{key:"pollGpuTimerQueries",value:function(){if(this.pendingGpuTimerQueries.length!==0){var e=this.webGLContext,r=this.gpuTimerExt;if(!r){this.pendingGpuTimerQueries.forEach(function(h){var c=h.query;return e.deleteQuery(c)}),this.pendingGpuTimerQueries=[];return}var i=e.getParameter(r.GPU_DISJOINT_EXT),o=[],s=z(this.pendingGpuTimerQueries),l;try{for(s.s();!(l=s.n()).done;){var u=l.value;if(!e.getQueryParameter(u.query,e.QUERY_RESULT_AVAILABLE)){o.push(u);continue}if(!i){var d=e.getQueryParameter(u.query,e.QUERY_RESULT);console.log("[sigma] DEBUG_gpuTimerQueries: frame #".concat(u.frameId," GPU time = ").concat((d/1e6).toFixed(2),"ms"))}e.deleteQuery(u.query)}}catch(h){s.e(h)}finally{s.f()}this.pendingGpuTimerQueries=o}}},{key:"postEvaluateNode",value:function(e,r,i){var o=e;o.x===void 0&&(o.x=r.x),o.y===void 0&&(o.y=r.y),e.highlighted=i.isHighlighted;for(var s=0,l=this.nodeVariableEntries.length;s<l;s++){var u,d,h=Q(this.nodeVariableEntries[s],2),c=h[0],f=h[1];o[c]=(u=(d=o[c])!==null&&d!==void 0?d:r[c])!==null&&u!==void 0?u:f.default}}},{key:"addNode",value:function(e){var r=this.internals.graph.getNodeAttributes(e),i=this.stateManager.getNodeState(e),o=this.internals.nodeDataCache[e]||{};if(ia(this.stylesDeclaration.nodes,r,i,this.stateManager.graphState,this.internals.graph,o),this.postEvaluateNode(o,r,i),this.nodeReducer){var s=this.nodeReducer(e,o,r,i,this.stateManager.graphState,this.internals.graph);o=W(W({},o),s)}if(typeof o.x!="number"||typeof o.y!="number")throw new Error('Sigma: could not find a valid position (x, y) for node "'.concat(e,'". ')+"Provide coordinates via node attributes, styles, or a nodeReducer.");this.internals.nodeShapeMap?(!o.shape||!(o.shape in this.internals.nodeShapeMap))&&(o.shape=Object.keys(this.internals.nodeShapeMap)[0]):this.nodeShapeSlug&&(o.shape=this.nodeShapeSlug),this.internals.nodeDataCache[e]=o,this.nodeGraphCoords[e]={x:o.x,y:o.y},qe(this.internals.nodesWithForcedLabels,e,We(o)),qe(this.internals.nodesWithBackdrop,e,ua(o)),this.itemBuckets.nodes.set(e,o.depth)}},{key:"updateNode",value:function(e){this.addNode(e);var r=this.internals.nodeDataCache[e];this.normalizationFunction.applyTo(r)}},{key:"removeNode",value:function(e){this.itemBuckets.nodes.remove(e),delete this.internals.nodeDataCache[e],delete this.nodeGraphCoords[e],delete this.nodeProgramIndex[e],this.internals.dragManager.removeNode(e),this.stateManager.removeNode(e),this.internals.nodesWithForcedLabels.delete(e),this.internals.nodesWithBackdrop.delete(e)}},{key:"postEvaluateEdge",value:function(e,r){for(var i=e,o=0,s=this.edgeVariableEntries.length;o<s;o++){var l,u,d=Q(this.edgeVariableEntries[o],2),h=d[0],c=d[1];i[h]=(l=(u=i[h])!==null&&u!==void 0?u:r[h])!==null&&l!==void 0?l:c.default}}},{key:"applyEdgeSpread",value:function(e,r,i){var o;if(!(i.parallelCount<=1)){var s=this.internals.graph.source(e),l=this.internals.graph.target(e),u=s===l,d=u?r.selfLoopPath||r.path:r.parallelPath||r.path,h=d?this.edgePathsByName.get(d):void 0;if(h!=null&&h.spread){var c=(o=r.parallelSpread)!==null&&o!==void 0?o:.25,f=h.spread.compute(i.parallelIndex,i.parallelCount,c);!u&&this.internals.graph.isDirected(e)&&s>l&&(f=-f),r[h.spread.variable]=f}}}},{key:"addEdge",value:function(e){var r=this.internals.graph.getEdgeAttributes(e),i=this.stateManager.getEdgeState(e),o={};if(oa(this.stylesDeclaration.edges,r,i,this.stateManager.graphState,this.internals.graph,o),this.postEvaluateEdge(o,r),this.edgeReducer){var s=this.edgeReducer(e,o,r,i,this.stateManager.graphState,this.internals.graph);o=W(W({},o),s)}this.applyEdgeSpread(e,o,i),this.internals.edgeDataCache[e]=o,qe(this.internals.edgesWithForcedLabels,e,We(o)),this.itemBuckets.edges.set(e,o.depth)}},{key:"updateEdge",value:function(e){this.addEdge(e)}},{key:"removeEdge",value:function(e){this.itemBuckets.edges.remove(e),delete this.internals.edgeDataCache[e],delete this.edgeProgramIndex[e],delete this.edgeTextureIndexCache[e],this.internals.edgeDataTexture.free(e),this.stateManager.removeEdge(e),this.internals.edgesWithForcedLabels.delete(e)}},{key:"clearNodeIndices",value:function(){this.labelRenderer.resetLabelGrid(),this.autoRescaleFrozen||(this.nodeExtent={x:[0,1],y:[0,1]}),this.internals.nodeDataCache={},this.nodeGraphCoords={},this.edgeProgramIndex={},this.internals.nodesWithForcedLabels.clear(),this.internals.nodesWithBackdrop.clear(),this.prevNodeVisibilities={},this.itemBuckets.nodes.clearAll(),this.depthRanges.nodes={},this.nodeBaseDepth={}}},{key:"clearEdgeIndices",value:function(){this.internals.edgeDataCache={},this.edgeProgramIndex={},this.edgeTextureIndexCache={},this.internals.edgesWithForcedLabels.clear(),La(this.pickingState,"edge"),this.itemBuckets.edges.clearAll(),this.depthRanges.edges={},this.edgeBaseDepth={},this.edgeGroups.clear()}},{key:"clearIndices",value:function(){this.clearEdgeIndices(),this.clearNodeIndices()}},{key:"clearNodeState",value:function(){this.labelRenderer.resetFrame(),this.internals.nodesWithBackdrop.clear(),this.internals.dragManager.clear(),this.autoRescaleFrozen=!1,this.stateManager.clearNodes()}},{key:"clearEdgeState",value:function(){this.labelRenderer.clearEdgeLabels(),this.stateManager.clearEdges()}},{key:"clearState",value:function(){this.clearEdgeState(),this.clearNodeState(),this.stateManager.resetGraphState()}},{key:"addNodeToProgram",value:function(e,r){var i,o=this.internals.nodeDataCache[e];this.internals.nodeDataTexture.allocate(e),(i=this.internals.nodeDataTexture).updateNode.apply(i,[e,o.x,o.y,o.size,this.getNodeShapeId(o)].concat($(mn(o)),[o.color]));var s=this.internals.nodeDataTexture.getIndex(e);this.nodeProgram.process(et(this.pickingState,"node",e),r,o,s,e),this.nodeProgramIndex[e]=r}},{key:"addEdgeToProgram",value:function(e,r){var i,o,s=this.internals.edgeDataCache[e],l=this.internals.graph.source(e),u=this.internals.graph.target(e),d=this.internals.edgeDataTexture.allocate(e);this.edgeTextureIndexCache[e]=d;var h=l===u,c=!h&&((i=(o=this.stateManager.getEdgeState(e))===null||o===void 0?void 0:o.parallelCount)!==null&&i!==void 0?i:1)>1,f=this.edgeProgram.resolveEdgeIds(s,h,c),g=f.pathId,m=f.headId,p=f.tailId,v=f.headLengthRatio,y=f.tailLengthRatio;this.internals.edgeDataTexture.updateEdge(e,this.internals.nodeDataTexture.getIndex(l),this.internals.nodeDataTexture.getIndex(u),s.size,v,y,g,m,p),this.edgeProgram.process(et(this.pickingState,"edge",e),r,this.internals.nodeDataCache[l],this.internals.nodeDataCache[u],s,d),this.edgeProgramIndex[e]=r}},{key:"getRenderParams",value:function(){return{frameId:this.frameId,matrix:this.matrix,invMatrix:this.invMatrix,width:this.width,height:this.height,pixelRatio:this.internals.pixelRatio,zoomRatio:this.camera.ratio,cameraAngle:this.camera.angle,sizeRatio:1/this.scaleSize(),correctionRatio:this.correctionRatio,downSizingRatio:this.internals.settings.pickingDownSizingRatio,minEdgeThickness:this.internals.settings.minEdgeThickness,antiAliasingFeather:this.internals.settings.antiAliasingFeather,nodePickingPadding:this.internals.settings.nodePickingPadding,edgePickingPadding:this.internals.settings.edgePickingPadding,labelPickingPadding:this.internals.settings.labelPickingPadding,nodeDataTextureUnit:Ki,nodeDataTextureWidth:this.internals.nodeDataTexture.getTextureWidth(),nodeFrameTextureUnit:Yi,nodeFrameTextureWidth:this.internals.nodeFrameTexture.getTextureWidth(),edgeDataTextureUnit:Zi,edgeDataTextureWidth:this.internals.edgeDataTexture.getTextureWidth(),edgeFrameTextureUnit:qi,edgeFrameTextureWidth:this.internals.edgeFrameTexture.getTextureWidth(),pickingFrameBuffer:this.pickingFrameBuffer,labelPixelSnapping:this.internals.settings.labelPixelSnapping?1:0}}},{key:"getStagePadding",value:function(){var e=this.internals.settings,r=e.stagePadding,i=e.autoRescale;return i&&r||0}},{key:"getLayerElement",value:function(e){if(e==="mouse")return this.mouseLayer;var r=this.extraElements[e];if(!r)throw new Error('Sigma: layer "'.concat(e,'" does not exist'));return r}},{key:"initWebGLContext",value:function(){var e=this,r=this.createWebGLContext("stage");this.stageCanvas=this.extraElements.stage,this.webGLContext=r,this.stageCanvas.addEventListener("webglcontextlost",function(i){e.webGLContext&&(i.preventDefault(),e.contextLost=!0,e.renderFrame&&(cancelAnimationFrame(e.renderFrame),e.renderFrame=null),e.gpuTimerExt=void 0,e.activeGpuTimerQuery=null,e.pendingGpuTimerQueries=[],e.emit("webglContextLost"))}),this.stageCanvas.addEventListener("webglcontextrestored",function(){requestAnimationFrame(function(){e.webGLContext&&!e.webGLContext.isContextLost()&&e.restoreWebGLContext()})}),this.initPickingFramebuffer()}},{key:"initPickingFramebuffer",value:function(){var e=this.webGLContext,r=e.createFramebuffer();if(!r)throw new Error("Sigma: cannot create picking frame buffer");e.bindFramebuffer(e.FRAMEBUFFER,r);var i=e.createTexture();if(!i)throw new Error("Sigma: cannot create picking texture");e.bindTexture(e.TEXTURE_2D,i),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,1,1,0,e.RGBA,e.UNSIGNED_BYTE,null),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,i,0);var o=e.createRenderbuffer();if(!o)throw new Error("Sigma: cannot create picking depth buffer");if(e.bindRenderbuffer(e.RENDERBUFFER,o),e.renderbufferStorage(e.RENDERBUFFER,e.DEPTH_COMPONENT16,1,1),e.framebufferRenderbuffer(e.FRAMEBUFFER,e.DEPTH_ATTACHMENT,e.RENDERBUFFER,o),e.checkFramebufferStatus(e.FRAMEBUFFER)!==e.FRAMEBUFFER_COMPLETE)throw new Error("Sigma: picking framebuffer is not complete");e.bindFramebuffer(e.FRAMEBUFFER,null),this.pickingFrameBuffer=r,this.pickingTexture=i,this.pickingDepthBuffer=o}},{key:"initPrograms",value:function(e,r){var i=this,o=this.webGLContext,s=wi(o,this.pickingFrameBuffer,i,e?.nodes,r.antialiasNodes),l=s.nodeProgram,u=s.labelProgram,d=s.backdropProgram,h=s.labelBackgroundProgram,c=s.attachmentProgram,f=s.framePass,g=s.shapeSlug,m=s.shapeNameToIndex,p=s.shapeGlobalIds,v=s.variables;this.nodeProgram=l,this.nodeFramePass=f,this.nodeVariableEntries=Object.entries(v),g&&(this.nodeShapeSlug=g);var y=Di(o,this.pickingFrameBuffer,i,e?.edges,r.antialiasEdges,e?.nodes),b=y.edgeProgram,T=y.createLabelPrograms,x=y.framePass,_=y.variables,S=y.paths;return this.createEdgeLabelPrograms=T,this.edgeProgram=b,this.edgeFramePass=x,this.edgeVariableEntries=Object.entries(_),this.edgePathsByName=new Map(S.map(function(A){return[A.name,A]})),{labelProgram:u,edgeLabelProgram:null,edgeLabelBackgroundProgram:null,backdropProgram:d,labelBackgroundProgram:h,attachmentProgram:c,nodeShapeMap:m??null,nodeGlobalShapeIds:p??null}}},{key:"restoreWebGLContext",value:function(){var e,r,i,o,s,l=this.internals;this.initPickingFramebuffer(),(e=l.nodeDataTexture)===null||e===void 0||e.restore(),(r=l.nodeFrameTexture)===null||r===void 0||r.restore(),(i=l.edgeDataTexture)===null||i===void 0||i.restore(),(o=l.edgeFrameTexture)===null||o===void 0||o.restore(),(s=l.attachmentManager)===null||s===void 0||s.restore(),l.hoverResolver.reset(),Object.assign(l,this.initPrograms(l.primitives,l.settings));var u=z(this.customLayerPrograms.values()),d;try{for(u.s();!(d=u.n()).done;){var h=d.value;h.program.kill(),h.program=h.factory(this.webGLContext)}}catch(c){u.e(c)}finally{u.f()}this.contextLost=!1,this.emit("webglContextRestored"),this.refresh()}},{key:"createLayer",value:function(e,r){var i=arguments.length>2&&arguments[2]!==void 0?arguments[2]:{};if(this.extraElements[e])throw new Error('Sigma: a layer named "'.concat(e,'" already exists'));var o=gt(r,{position:"absolute"},{class:"sigma-".concat(e)});return i.style&&Object.assign(o.style,i.style),this.extraElements[e]=o,"beforeLayer"in i&&i.beforeLayer?this.getLayerElement(i.beforeLayer).before(o):"afterLayer"in i&&i.afterLayer?this.getLayerElement(i.afterLayer).after(o):this.container.appendChild(o),o}},{key:"createCanvas",value:function(e){var r=arguments.length>1&&arguments[1]!==void 0?arguments[1]:{};return this.createLayer(e,"canvas",r)}},{key:"createWebGLContext",value:function(e){var r=arguments.length>1&&arguments[1]!==void 0?arguments[1]:{},i=this.createCanvas(e,r);r.hidden&&i.remove();var o=i.getContext("webgl2",W({preserveDrawingBuffer:!1,antialias:!1,depth:!0},r));if(!o)throw new Error("Sigma: WebGL 2 is not supported by your browser. Please use a modern browser (Chrome 56+, Firefox 51+, Safari 15+, Edge 79+).");return o.blendFunc(o.ONE,o.ONE_MINUS_SRC_ALPHA),o}},{key:"killLayer",value:function(e){if(e==="stage"||e==="mouse")throw new Error('Sigma: cannot kill built-in layer "'.concat(e,'"'));var r=this.extraElements[e];if(!r)throw new Error("Sigma: cannot kill layer ".concat(e,", which does not exist"));return r.remove(),delete this.extraElements[e],this}},{key:"getWebGLContext",value:function(){if(!this.webGLContext)throw new Error("Sigma: WebGL context is not available");return this.webGLContext}},{key:"getNodeDataTexture",value:function(){if(!this.internals.nodeDataTexture)throw new Error("Sigma: node data texture is not available");return this.internals.nodeDataTexture}},{key:"getNormalizationFunction",value:function(){return this.normalizationFunction}},{key:"addCustomLayerProgram",value:function(e,r,i){var o;if(!this.depthLayers.includes(r))throw new Error('Sigma: cannot add custom layer program at depth "'.concat(r,'", ')+"it must be declared in primitives.depthLayers. Current layers: ".concat(this.depthLayers.join(", ")));(o=this.customLayerPrograms.get(e))===null||o===void 0||o.program.kill();var s=i(this.webGLContext);return this.customLayerPrograms.set(e,{depth:r,factory:i,program:s}),s.cacheData&&s.cacheData(),this.scheduleRender(),this}},{key:"removeCustomLayerProgram",value:function(e){var r=this.customLayerPrograms.get(e);return r&&(r.program.kill(),this.customLayerPrograms.delete(e),this.scheduleRender()),this}},{key:"getCamera",value:function(){return this.camera}},{key:"setCamera",value:function(e){return this.camera.cancelAnimation(),this.unbindCameraHandlers(),this.camera=e,this.bindCameraHandlers(),this.scheduleRender(),this}},{key:"getContainer",value:function(){return this.container}},{key:"getGraph",value:function(){return this.internals.graph}},{key:"setGraph",value:function(e){return e===this.internals.graph?this:(this.stateManager.pruneNodes(function(r){return e.hasNode(r)}),this.stateManager.pruneEdges(function(r){return e.hasEdge(r)}),this.unbindGraphHandlers(),this.checkEdgesEventsFrame!==null&&(cancelAnimationFrame(this.checkEdgesEventsFrame),this.checkEdgesEventsFrame=null),this.internals.graph=e,this.autoRescaleFrozen=!1,this.bindGraphHandlers(),this.refresh(),this)}},{key:"getMouseCaptor",value:function(){return this.mouseCaptor}},{key:"getTouchCaptor",value:function(){return this.touchCaptor}},{key:"getDimensions",value:function(){return{width:this.width,height:this.height}}},{key:"getGraphDimensions",value:function(){var e=this.customBBox||this.nodeExtent;return{width:e.x[1]-e.x[0]||1,height:e.y[1]-e.y[0]||1}}},{key:"getNodeDisplayData",value:function(e){var r=this.internals.nodeDataCache[e];return r?Object.assign({},r):void 0}},{key:"getEdgeDisplayData",value:function(e){var r=this.internals.edgeDataCache[e];return r?Object.assign({},r):void 0}},{key:"getNodeState",value:function(e){return this.stateManager.getNodeState(e)}},{key:"getEdgeState",value:function(e){return this.stateManager.getEdgeState(e)}},{key:"getGraphState",value:function(){return this.stateManager.getGraphState()}},{key:"setNodeState",value:function(e,r){return this.stateManager.setNodeState(e,r),this}},{key:"setEdgeState",value:function(e,r){return this.stateManager.setEdgeState(e,r),this}},{key:"setGraphState",value:function(e){return this.stateManager.setGraphState(e),this}},{key:"_setPanning",value:function(e){this.stateManager.setGraphState({isPanning:e})}},{key:"_setZooming",value:function(e){this.stateManager.setGraphState({isZooming:e})}},{key:"_hasNodeDrag",value:function(){var e=this.internals.dragManager;return!!(e.pendingNode||e.session)}},{key:"_showGestureHint",value:function(e){var r=this.internals.settings;r.gestureTarget==="shared"&&(this.gestureHint=this.gestureHint||new mh(this.container),this.gestureHint.show(e,r))}},{key:"setNodesState",value:function(e,r){return this.stateManager.setNodesState(e,r),this}},{key:"setEdgesState",value:function(e,r){return this.stateManager.setEdgesState(e,r),this}},{key:"updateContainerCursor",value:function(){var e=this.stateManager.hovered,r=this.resolvedStageStyle.cursor||"";this.container.style.cursor=e&&nh(this.internals,e)||r}},{key:"refreshStageStyle",value:function(){this.resolvedStageStyle=sa(this.stylesDeclaration.stage,this.stateManager.graphState),this.resolvedStageStyle.background!==void 0&&(this.container.style.backgroundColor=this.resolvedStageStyle.background),this.updateContainerCursor()}},{key:"getNodeDisplayedLabels",value:function(){return new Set(this.labelRenderer.displayedNodeLabels)}},{key:"getEdgeDisplayedLabels",value:function(){return new Set(this.labelRenderer.displayedEdgeLabels)}},{key:"getSettings",value:function(){return W({},this.internals.settings)}},{key:"getSetting",value:function(e){return this.internals.settings[e]}},{key:"getStyles",value:function(){return W({},this.stylesDeclaration)}},{key:"getPrimitives",value:function(){return W({},this.internals.primitives)}},{key:"setSetting",value:function(e,r){return this.internals.settings[e]=r,xn(this.internals.settings),this.handleSettingsUpdate(),this.scheduleRefresh(),this}},{key:"updateSetting",value:function(e,r){return this.setSetting(e,r(this.internals.settings[e])),this}},{key:"setSettings",value:function(e){return this.internals.settings=W(W({},this.internals.settings),e),xn(this.internals.settings),this.handleSettingsUpdate(),this.scheduleRefresh(),this}},{key:"resize",value:function(e){var r=this.width,i=this.height;if(this.width=this.container.offsetWidth,this.height=this.container.offsetHeight,this.internals.pixelRatio=Nt(),this.width===0)if(this.internals.settings.allowInvalidContainer)this.width=1;else throw new Error("Sigma: Container has no width. You can set the allowInvalidContainer setting to true to stop seeing this error.");if(this.height===0)if(this.internals.settings.allowInvalidContainer)this.height=1;else throw new Error("Sigma: Container has no height. You can set the allowInvalidContainer setting to true to stop seeing this error.");if(!e&&r===this.width&&i===this.height)return this;this.labelRenderer.labelsDirty=!0;for(var o=0,s=[this.mouseLayer].concat($(Object.values(this.extraElements)));o<s.length;o++){var l=s[o];l.style.width=this.width+"px",l.style.height=this.height+"px"}return this.webGLContext&&(this.stageCanvas.setAttribute("width",this.width*this.internals.pixelRatio+"px"),this.stageCanvas.setAttribute("height",this.height*this.internals.pixelRatio+"px"),this.webGLContext.viewport(0,0,this.width*this.internals.pixelRatio,this.height*this.internals.pixelRatio)),this.emit("resize"),this}},{key:"clear",value:function(){return this.emit("beforeClear"),this.webGLContext.bindFramebuffer(WebGLRenderingContext.FRAMEBUFFER,null),this.webGLContext.clear(WebGLRenderingContext.COLOR_BUFFER_BIT),this.emit("afterClear"),this}},{key:"scheduleStateRefresh",value:function(){this.needToRefreshState=!0,this.scheduleRender()}},{key:"refreshState",value:function(){var e=this,r;this.stateManager.flushGraphStateFlags();var i=this.stateManager.graphStateChanged&&this.internals.nodeStyleAnalysis.dependency==="graph-state",o=this.stateManager.graphStateChanged&&this.edgeStyleAnalysis.dependency==="graph-state",s=!1;if(i)this.internals.graph.forEachNode(function(g){e.refreshNodeState(g)&&(s=!0)});else if(this.internals.nodeStyleAnalysis.dependency!=="static"){var l=z(this.stateManager.dirtyNodes),u;try{for(l.s();!(u=l.n()).done;){var d=u.value;this.refreshNodeState(d)&&(s=!0)}}catch(g){l.e(g)}finally{l.f()}}if(o)this.internals.graph.forEachEdge(function(g){e.refreshEdgeState(g)&&(s=!0)});else if(this.edgeStyleAnalysis.dependency!=="static"){var h=z(this.stateManager.dirtyEdges),c;try{for(h.s();!(c=h.n()).done;){var f=c.value;this.refreshEdgeState(f)&&(s=!0)}}catch(g){h.e(g)}finally{h.f()}}this.stateManager.graphStateChanged&&(r=this.stylesDeclaration)!==null&&r!==void 0&&r.stage&&this.refreshStageStyle(),this.stateManager.clearDirtyTracking(),s&&(this.pendingProcess="full")}},{key:"refreshNodeState",value:function(e){var r=this.internals.nodeDataCache[e];if(!r||this.nodeReducer){var i,o,s,l,u=(i=this.internals.nodeDataCache[e])===null||i===void 0?void 0:i.depth,d=(o=this.internals.nodeDataCache[e])===null||o===void 0?void 0:o.zIndex,h=(s=this.internals.nodeDataCache[e])===null||s===void 0?void 0:s.labelAttachment;this.updateNode(e);var c=this.internals.nodeDataCache[e];this.internals.attachmentManager&&c.labelAttachment!==h&&this.internals.attachmentManager.invalidateNode(e);var f;this.internals.nodeShapeMap&&this.internals.nodeGlobalShapeIds&&c.shape&&c.shape in this.internals.nodeShapeMap?f=this.internals.nodeGlobalShapeIds[this.internals.nodeShapeMap[c.shape]]:f=Bt(c.shape||"circle"),(l=this.internals.nodeDataTexture).updateNode.apply(l,[e,c.x,c.y,c.size,f].concat($(mn(c)),[c.color])),u&&c.depth!==u&&this.updateNodeDepthRanges(e,u,c.depth);var g=this.nodeProgramIndex[e];return g!==void 0&&(this.addNodeToProgram(e,g),this.nodeProgram.invalidateBuffers()),d!==void 0&&c.zIndex!==d}var m=this.internals.graph.getNodeAttributes(e),p=this.stateManager.getNodeState(e),v=r.size,y=r.shape,b=r.depth,T=r.zIndex,x=r.labelAttachment,_=r.rotationAlignment,S=r.labelRotationAlignment,A=r.color;ia(this.stylesDeclaration.nodes,m,p,this.stateManager.graphState,this.internals.graph,r),this.postEvaluateNode(r,m,p);var R=this.nodeGraphCoords[e],w=r.x!==R.x||r.y!==R.y;if(w&&(R.x=r.x,R.y=r.y),this.normalizationFunction.applyTo(r),this.internals.nodeShapeMap?(!r.shape||!(r.shape in this.internals.nodeShapeMap))&&(r.shape=Object.keys(this.internals.nodeShapeMap)[0]):this.nodeShapeSlug&&(r.shape=this.nodeShapeSlug),this.internals.attachmentManager&&r.labelAttachment!==x&&this.internals.attachmentManager.invalidateNode(e),qe(this.internals.nodesWithForcedLabels,e,We(r)),qe(this.internals.nodesWithBackdrop,e,ua(r)),w||r.size!==v||r.shape!==y||r.rotationAlignment!==_||r.labelRotationAlignment!==S||r.color!==A){var F,D;this.internals.nodeShapeMap&&this.internals.nodeGlobalShapeIds&&r.shape&&r.shape in this.internals.nodeShapeMap?D=this.internals.nodeGlobalShapeIds[this.internals.nodeShapeMap[r.shape]]:D=Bt(r.shape||"circle"),(F=this.internals.nodeDataTexture).updateNode.apply(F,[e,r.x,r.y,r.size,D].concat($(mn(r)),[r.color]))}this.itemBuckets.nodes.set(e,r.depth),r.depth!==b&&this.updateNodeDepthRanges(e,b,r.depth);var I=this.nodeProgramIndex[e];return I!==void 0&&(this.addNodeToProgram(e,I),this.nodeProgram.invalidateBuffers()),r.zIndex!==T}},{key:"refreshEdgeState",value:function(e){var r=this.internals.edgeDataCache[e];if(!r||this.edgeReducer){var i=r?.depth,o=r?.zIndex;this.updateEdge(e);var s=this.internals.edgeDataCache[e];i&&s.depth!==i&&this.updateEdgeDepthRanges(e,i,s.depth);var l=this.edgeProgramIndex[e];return l!==void 0&&(this.addEdgeToProgram(e,l),this.edgeProgram.invalidateBuffers()),o!==void 0&&s.zIndex!==o}var u=this.internals.graph.getEdgeAttributes(e),d=this.stateManager.getEdgeState(e),h=r.depth,c=r.zIndex,f=r.size,g=r.path,m=r.selfLoopPath,p=r.parallelPath,v=r.head,y=r.tail;oa(this.stylesDeclaration.edges,u,d,this.stateManager.graphState,this.internals.graph,r),this.postEvaluateEdge(r,u),this.applyEdgeSpread(e,r,d),qe(this.internals.edgesWithForcedLabels,e,We(r)),this.itemBuckets.edges.set(e,r.depth),r.depth!==h&&this.updateEdgeDepthRanges(e,h,r.depth);var b=this.edgeProgramIndex[e];if(b!==void 0){var T=r.size!==f||r.path!==g||r.selfLoopPath!==m||r.parallelPath!==p||r.head!==v||r.tail!==y;if(T)this.addEdgeToProgram(e,b),this.edgeProgram.invalidateBuffers();else{var x=this.internals.graph.source(e),_=this.internals.graph.target(e),S=this.internals.nodeDataCache[x],A=this.internals.nodeDataCache[_],R=this.edgeTextureIndexCache[e];this.edgeProgram.process(et(this.pickingState,"edge",e),b,S,A,r,R),this.edgeProgram.invalidateBuffers()}}return r.zIndex!==c}},{key:"refresh",value:function(e){var r=this,i=e?.skipIndexation!==void 0?e?.skipIndexation:!1,o=e?.schedule!==void 0?e.schedule:!1,s=!e||!e.partialGraph;if(s)this.clearEdgeIndices(),this.clearNodeIndices(),this.internals.graph.forEachNode(function(S){return r.addNode(S)}),this.edgeGroups.rebuild(),this.internals.graph.forEachEdge(function(S){return r.addEdge(S)}),this.pendingProcess="full";else{for(var l,u,d=((l=e.partialGraph)===null||l===void 0?void 0:l.nodes)||[],h=0,c=d?.length||0;h<c;h++){var f,g,m=""+d[h],p=(f=this.internals.nodeDataCache[m])===null||f===void 0?void 0:f.labelAttachment;if(this.updateNode(m),this.internals.attachmentManager&&((g=this.internals.nodeDataCache[m])!==null&&g!==void 0&&g.labelAttachment||p)&&this.internals.attachmentManager.invalidateNode(m),i){var v=this.nodeProgramIndex[m];if(v===void 0)throw new Error('Sigma: node "'.concat(m,`" can't be repaint`));this.addNodeToProgram(m,v)}}i&&d.length>0&&(this.nodeProgram.invalidateBuffers(),this.labelRenderer.labelsDirty=!0);for(var y=(e==null||(u=e.partialGraph)===null||u===void 0?void 0:u.edges)||[],b=0,T=y.length;b<T;b++){var x=""+y[b];if(this.updateEdge(x),i){var _=this.edgeProgramIndex[x];if(_===void 0)throw new Error('Sigma: edge "'.concat(x,`" can't be repaint`));this.addEdgeToProgram(x,_)}}i&&y.length>0&&(this.edgeProgram.invalidateBuffers(),this.labelRenderer.labelsDirty=!0),!i&&this.pendingProcess!=="full"&&(this.pendingProcess=y.length>0?"full":"nodes")}return o?this.scheduleRender():this.render(),this}},{key:"scheduleRender",value:function(){var e=this;return this.renderFrame||(this.renderFrame=requestAnimationFrame(function(){e.render()})),this}},{key:"scheduleRefresh",value:function(e){return this.refresh(W(W({},e),{},{schedule:!0}))}},{key:"getViewportZoomedState",value:function(e,r){var i=this.camera.getState(),o=i.ratio,s=i.angle,l=i.x,u=i.y,d=this.internals.settings,h=d.minCameraRatio,c=d.maxCameraRatio;typeof c=="number"&&(r=Math.min(r,c)),typeof h=="number"&&(r=Math.max(r,h));var f=r/o,g={x:this.width/2,y:this.height/2},m=this.viewportToFramedGraph(e),p=this.viewportToFramedGraph(g);return{angle:s,x:(m.x-p.x)*(1-f)+l,y:(m.y-p.y)*(1-f)+u,ratio:r}}},{key:"viewRectangle",value:function(){var e=this.viewportToFramedGraph({x:0,y:0}),r=this.viewportToFramedGraph({x:this.width,y:0}),i=this.viewportToFramedGraph({x:0,y:this.height});return{x1:e.x,y1:e.y,x2:r.x,y2:r.y,height:r.y-i.y}}},{key:"framedGraphToViewport",value:function(e){var r=arguments.length>1&&arguments[1]!==void 0?arguments[1]:{},i=!!r.cameraState||!!r.viewportDimensions||!!r.graphDimensions||!!r.padding,o=r.matrix||(i?Me(r.cameraState||this.camera.getState(),r.viewportDimensions||this.getDimensions(),r.graphDimensions||this.getGraphDimensions(),r.padding||this.getStagePadding()):this.matrix),s=ut(o,e);return{x:(1+s.x)*this.width/2,y:(1-s.y)*this.height/2}}},{key:"viewportToFramedGraph",value:function(e){var r=arguments.length>1&&arguments[1]!==void 0?arguments[1]:{},i=!!r.cameraState||!!r.viewportDimensions||!!r.graphDimensions||!!r.padding,o=r.matrix||(i?Me(r.cameraState||this.camera.getState(),r.viewportDimensions||this.getDimensions(),r.graphDimensions||this.getGraphDimensions(),r.padding||this.getStagePadding(),!0):this.invMatrix),s=ut(o,{x:e.x/this.width*2-1,y:1-e.y/this.height*2});return isNaN(s.x)&&(s.x=0),isNaN(s.y)&&(s.y=0),s}},{key:"viewportToGraph",value:function(e){var r=arguments.length>1&&arguments[1]!==void 0?arguments[1]:{};return this.normalizationFunction.inverse(this.viewportToFramedGraph(e,r))}},{key:"graphToViewport",value:function(e){var r=arguments.length>1&&arguments[1]!==void 0?arguments[1]:{};return this.framedGraphToViewport(this.normalizationFunction(e),r)}},{key:"graphToFramedGraph",value:function(e){return this.normalizationFunction(e)}},{key:"framedGraphToGraph",value:function(e){return this.normalizationFunction.inverse(e)}},{key:"getGraphToViewportRatio",value:function(){var e={x:0,y:0},r={x:1,y:1},i=Math.sqrt(Math.pow(e.x-r.x,2)+Math.pow(e.y-r.y,2)),o=this.graphToViewport(e),s=this.graphToViewport(r),l=Math.sqrt(Math.pow(o.x-s.x,2)+Math.pow(o.y-s.y,2));return l/i}},{key:"computeNodeExtent",value:function(){var e=this.nodeGraphCoords,r=Object.keys(e);if(!r.length)return{x:[0,1],y:[0,1]};for(var i=1/0,o=-1/0,s=1/0,l=-1/0,u=0,d=r.length;u<d;u++){var h=e[r[u]],c=h.x,f=h.y;c<i&&(i=c),c>o&&(o=c),f<s&&(s=f),f>l&&(l=f)}return{x:[i,o],y:[s,l]}}},{key:"getBBox",value:function(){return this.nodeExtent}},{key:"getCustomBBox",value:function(){return this.customBBox}},{key:"setCustomBBox",value:function(e){return this.customBBox=e,this.scheduleRender(),this}},{key:"kill",value:function(){var e,r,i,o,s;this.emit("kill"),this.removeAllListeners(),this.camera.cancelAnimation(),this.unbindCameraHandlers(),window.removeEventListener("resize",this.activeListeners.handleResize),this.mouseCaptor.kill(),this.touchCaptor.kill(),this.internals.hoverResolver.kill(),this.unbindGraphHandlers(),this.clearIndices(),this.clearState(),this.internals.nodeDataCache={},this.internals.edgeDataCache={},this.renderFrame&&(cancelAnimationFrame(this.renderFrame),this.renderFrame=null);for(var l=this.container;l.firstChild;)l.removeChild(l.firstChild);this.nodeProgram.kill(),this.nodeFramePass.kill(),this.edgeProgram.kill(),this.edgeFramePass.kill(),this.internals.labelProgram.kill(),(e=this.internals.edgeLabelProgram)===null||e===void 0||e.kill(),(r=this.internals.edgeLabelBackgroundProgram)===null||r===void 0||r.kill(),this.internals.backdropProgram.kill(),this.internals.labelBackgroundProgram.kill(),(i=this.internals.attachmentProgram)===null||i===void 0||i.kill(),(o=this.internals.attachmentManager)===null||o===void 0||o.kill(),this.internals.attachmentProgram=null,this.internals.attachmentManager=null;var u=z(this.customLayerPrograms.values()),d;try{for(u.s();!(d=u.n()).done;){var h=d.value.program;h.kill()}}catch(g){u.e(g)}finally{u.f()}if(this.customLayerPrograms.clear(),this.sdfAtlas&&(this.sdfAtlas=null),this.internals.nodeDataTexture&&(this.internals.nodeDataTexture.kill(),this.internals.nodeDataTexture=null),this.internals.nodeFrameTexture&&(this.internals.nodeFrameTexture.kill(),this.internals.nodeFrameTexture=null),this.internals.edgeDataTexture&&(this.internals.edgeDataTexture.kill(),this.internals.edgeDataTexture=null),this.internals.edgeFrameTexture&&(this.internals.edgeFrameTexture.kill(),this.internals.edgeFrameTexture=null),this.webGLContext){var c;(c=this.webGLContext.getExtension("WEBGL_lose_context"))===null||c===void 0||c.loseContext(),this.webGLContext=null}(s=this.gestureHint)===null||s===void 0||s.kill(),this.gestureHint=null,this.mouseLayer.remove();for(var f in this.extraElements)this.extraElements[f].remove();this.extraElements={}}},{key:"scaleSize",value:function(){var e=arguments.length>0&&arguments[0]!==void 0?arguments[0]:1,r=arguments.length>1&&arguments[1]!==void 0?arguments[1]:this.camera.ratio;return e/this.internals.settings.zoomToSizeRatioFunction(r)*(this.getSetting("itemSizesReference")==="positions"?r*this.graphToViewportRatio:1)}},{key:"getStageCanvas",value:function(){return this.stageCanvas}},{key:"getMouseLayer",value:function(){return this.mouseLayer}}])}(pn),no=Ah;var ko=Ve(Lo(),1);window.LIBS={Graph:ee,Sigma:no,louvain:ko.default};})();
