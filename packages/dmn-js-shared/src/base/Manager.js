import EventBus from 'diagram-js/lib/core/EventBus';

import DmnModdle from 'dmn-moddle';

import CamundaModdle from 'camunda-dmn-moddle/resources/camunda.json';

import {
  domify,
  query as domQuery,
  remove as domRemove
} from 'min-dom';

import {
  assign,
  debounce,
  every,
  find,
  isDefined,
  isFunction,
  isNumber
} from 'min-dash';

import {
  wrapForCompatibility
} from '../util/CompatibilityUtils';


/**
 * @typedef {import('./View').OpenResult} OpenResult
 */

/**
 * @typedef {import('./View').OpenError} OpenError
 */


const DEFAULT_CONTAINER_OPTIONS = {
  width: '100%',
  height: '100%',
  position: 'relative'
};

/**
 * The base class for DMN viewers and editors.
 *
 * @abstract
 */
export default class Manager {

  /**
   * Create a new instance with the given options.
   *
   * @param  {Object} options
   *
   * @return {Manager}
   */
  constructor(options={}) {
    this._eventBus = new EventBus();

    this._viewsChanged = debounce(this._viewsChanged, 0);

    this._views = [];
    this._viewers = {};

    // keep support for callbacks
    this.open = wrapForCompatibility(this.open.bind(this));

    this._init(options);
  }

  /**
   * Parse and render a DMN diagram.
   *
   * Once finished the viewer reports back the result to the
   * provided callback function with (err, warnings).
   *
   * ## Life-Cycle Events
   *
   * During import the viewer will fire life-cycle events:
   *
   *   * import.parse.start (about to read model from xml)
   *   * import.parse.complete (model read; may have worked or not)
   *   * import.render.start (graphical import start)
   *   * import.render.complete (graphical import finished)
   *   * import.done (everything done)
   *
   * You can use these events to hook into the life-cycle.
   *
   * @param {string} xml the DMN xml
   * @param {Object} [options]
   * @param {boolean} [options.open=true]
   * @param {Function} [done] invoked with (err, warnings=[])
   */
  importXML(xml, options, done) {
    var self = this;

    if (typeof options !== 'object') {
      done = options;
      options = { open: true };
    }

    if (typeof done !== 'function') {
      done = noop;
    }

    // hook in pre-parse listeners +
    // allow xml manipulation
    xml = this._emit('import.parse.start', { xml: xml }) || xml;

    this._moddle.fromXML(xml, 'dmn:Definitions').then((parseResult) => {

      var definitions = parseResult.rootElement;
      var references = parseResult.references;
      var elementsById = parseResult.elementsById;
      var parseWarnings = parseResult.warnings;

      // hook in post parse listeners +
      // allow definitions manipulation
      definitions = self._emit('import.parse.complete', ParseCompleteEvent({
        error: null,
        definitions: definitions,
        elementsById: elementsById,
        references: references,
        warnings: parseWarnings
      })) || definitions;
      self._setDefinitions(definitions);

      if (!options.open) {
        self._emit('import.done', { error: null, warnings: parseWarnings });

        return done(null, parseWarnings);
      }

      return { parseWarnings };
    }).catch((parseError) => {

      var parseWarnings = parseError.warnings;

      parseError = checkDMNCompatibilityError(parseError, xml) ||
        checkValidationError(parseError) ||
        parseError;

      self._emit('import.done', { error: parseError, warnings: parseWarnings });

      return done(parseError, parseWarnings);
    }).then((result) => {

      var parseWarnings = result.parseWarnings;

      var view = self._activeView || self._getInitialView(self._views);

      if (!view) {
        return done(new Error('no displayable contents'));
      }

      self.open(view)
        .then(
          result => {
            var allWarnings = [].concat(parseWarnings, result.warnings);

            self._emit('import.done', { error: null, warnings: allWarnings });

            done(null, allWarnings);
          })
        .catch(
          error => {
            var allWarnings = [].concat(parseWarnings, error.warnings);

            self._emit('import.done', { error: error, warnings: allWarnings });

            done(error, allWarnings);
          }
        );
    });

    // TODO: remove with future dmn-js version
    function ParseCompleteEvent(data) {

      var event = self._eventBus.createEvent(data);

      Object.defineProperty(event, 'context', {
        enumerable: true,
        get: function() {

          console.warn(new Error(
            'import.parse.complete <context> is deprecated ' +
            'and will be removed in future library versions'
          ));

          return {
            warnings: data.warnings,
            references: data.references,
            elementsById: data.elementsById
          };
        }
      });

      return event;
    }
  }

  getDefinitions() {
    return this._definitions;
  }

  /**
   * Return active view.
   *
   * @return {View}
   */
  getActiveView() {
    return this._activeView;
  }

  /**
   * Get the currently active viewer instance.
   *
   * @return {View}
   */
  getActiveViewer() {
    var activeView = this.getActiveView();

    return activeView && this._getViewer(activeView);
  }

  getView(element) {
    return this._views.filter(function(v) {
      return v.element === element;
    })[0];
  }

  getViews() {
    return this._views;
  }

  /**
   * Export the currently displayed DMN diagram as
   * a DMN XML document.
   *
   * ## Life-Cycle Events
   *
   * During XML saving the viewer will fire life-cycle events:
   *
   *   * saveXML.start (before serialization)
   *   * saveXML.serialized (after xml generation)
   *   * saveXML.done (everything done)
   *
   * You can use these events to hook into the life-cycle.
   *
   * @param {Object} [options] export options
   * @param {boolean} [options.format=false] output formated XML
   * @param {boolean} [options.preamble=true] output preamble
   * @param {Function} done invoked with (err, xml)
   */
  saveXML(options, done) {
    var self = this;

    if (typeof options === 'function') {
      done = options;
      options = {};
    }

    var definitions = this._definitions;

    if (!definitions) {
      return done(new Error('no definitions loaded'));
    }

    // allow to fiddle around with definitions
    definitions = this._emit('saveXML.start', {
      definitions: definitions
    }) || definitions;

    this._moddle.toXML(definitions, options).then(function(result) {

      var xml = result.xml;

      return { xml };
    }).catch((error) => {

      return { error };
    }).then((result) => {

      var xml = result.xml;
      var error = result.error;

      try {
        xml = self._emit('saveXML.serialized', {
          error: error,
          xml: xml
        }) || xml;

        self._emit('saveXML.done', {
          error: error,
          xml: xml
        });
      } catch (e) {
        console.error('error in saveXML life-cycle listener', e);
      }

      done(error, xml);
    });
  }

  /**
   * Register an event listener
   *
   * Remove a previously added listener via {@link #off(event, callback)}.
   *
   * @param {string} event
   * @param {number} [priority]
   * @param {Function} callback
   * @param {Object} [that]
   */
  on(...args) {
    this._eventBus.on(...args);
  }

  /**
   * De-register an event listener
   *
   * @param {string} event
   * @param {Function} callback
   */
  off(...args) {
    this._eventBus.off(...args);
  }

  /**
   * Register a listener to be invoked once only.
   *
   * @param {string} event
   * @param {number} [priority]
   * @param {Function} callback
   * @param {Object} [that]
   */
  once(...args) {
    this._eventBus.once(...args);
  }

  attachTo(parentNode) {

    // unwrap jQuery if provided
    if (parentNode.get && parentNode.constructor.prototype.jquery) {
      parentNode = parentNode.get(0);
    }

    if (typeof parentNode === 'string') {
      parentNode = domQuery(parentNode);
    }

    parentNode.appendChild(this._container);

    this._emit('attach', {});
  }

  detach() {
    this._emit('detach', {});

    domRemove(this._container);
  }

  destroy() {
    Object.keys(this._viewers).forEach((viewerId) => {
      var viewer = this._viewers[viewerId];

      safeExecute(viewer, 'destroy');
    });

    domRemove(this._container);
  }

  _init(options) {
    this._options = options;

    this._moddle = this._createModdle(options);

    this._viewers = {};
    this._views = [];

    const container = domify('<div class="dmn-js-parent"></div>');

    const containerOptions = assign({}, DEFAULT_CONTAINER_OPTIONS, options);

    assign(container.style, {
      width: ensureUnit(containerOptions.width),
      height: ensureUnit(containerOptions.height),
      position: containerOptions.position
    });

    this._container = container;

    if (options.container) {
      this.attachTo(options.container);
    }
  }

  /**
   * Open diagram view.
   *
   * @param  {View} view
   * @returns {Promise} Resolves with {OpenResult} when successful
   * or rejects with {OpenError}
   */
  open(view) {
    return this._switchView(view);
  }

  _setDefinitions(definitions) {
    this._definitions = definitions;

    this._updateViews();
  }

  _viewsChanged = () => {
    this._emit('views.changed', {
      views: this._views,
      activeView: this._activeView
    });
  }

  /**
   * Recompute changed views after elements in
   * the DMN diagram have changed.
   */
  _updateViews() {

    var definitions = this._definitions;

    if (!definitions) {
      this._views = [];
      this._switchView(null);

      return;
    }

    var viewProviders = this._getViewProviders();

    var displayableElements = [ definitions, ...(definitions.drgElement || []) ];

    // compute list of available views
    var views = this._views,
        newViews = [];

    for (var element of displayableElements) {
      var provider = find(viewProviders, function(provider) {
        if (typeof provider.opens === 'string') {
          return provider.opens === element.$type;
        } else {
          return provider.opens(element);
        }
      });

      if (!provider) {
        continue;
      }

      var view = {
        element,
        id: element.id,
        name: element.name,
        type: provider.id
      };

      newViews.push(view);
    }

    var activeView = this._activeView,
        newActiveView;

    if (activeView) {

      // check the new active view
      newActiveView = find(newViews, function(view) {
        return viewsEqual(activeView, view);
      }) || this._getInitialView(newViews);

      if (!newActiveView) {
        this._switchView(null);
        return;
      }
    }

    // Views have changed if
    // active view has changed OR
    // number of views has changed OR
    // not all views equal
    var activeViewChanged = !viewsEqual(activeView, newActiveView)
      || viewNameChanged(activeView, newActiveView);

    var viewsChanged = views.length !== newViews.length
        || !every(newViews, function(newView) {
          return find(views, function(view) {
            return viewsEqual(view, newView) && !viewNameChanged(view, newView);
          });
        });

    this._activeView = newActiveView;
    this._views = newViews;

    if (activeViewChanged || viewsChanged) {
      this._viewsChanged();
    }
  }

  _getInitialView(views) {
    return views[0];
  }

  /**
   * Switch to another view.
   *
   * @param  {View} newView
   * @returns {Promise} Resolves with {OpenResult} when successful
   * or rejects with {OpenError}
   */
  _switchView(newView) {
    var self = this;

    return new Promise(function(resolve, reject) {
      var complete = (openError, openResult) => {
        self._viewsChanged();

        if (openError) {
          reject(openError);
        } else {
          resolve(openResult);
        }
      };

      var activeView = self.getActiveView(),
          activeViewer;

      var newViewer = newView && self._getViewer(newView),
          element = newView && newView.element;

      if (activeView) {
        activeViewer = self._getViewer(activeView);

        if (activeViewer !== newViewer) {
          safeExecute(activeViewer, 'clear');

          activeViewer.detach();
        }
      }

      self._activeView = newView;

      if (newViewer) {

        if (activeViewer !== newViewer) {
          newViewer.attachTo(self._container);
        }

        self._emit('import.render.start', {
          view: newView,
          element: element
        });

        newViewer.open(element)
          .then(
            result => {
              self._emit('import.render.complete', {
                view: newView,
                error: null,
                warnings: result.warnings
              });

              complete(null, result);
            })
          .catch(
            error => {
              self._emit('import.render.complete', {
                view: newView,
                error: error,
                warnings: error.warnings
              });

              complete(error, null);
            }
          );

        return;
      }

      // no active view
      complete();
    });
  }

  _getViewer(view) {

    var type = view.type;

    var viewer = this._viewers[type];

    if (!viewer) {
      viewer = this._viewers[type] = this._createViewer(view.type);

      this._emit('viewer.created', {
        type: type,
        viewer: viewer
      });
    }

    return viewer;
  }

  _createViewer(id) {

    var provider = find(this._getViewProviders(), function(provider) {
      return provider.id === id;
    });

    if (!provider) {
      throw new Error('no provider for view type <' + id + '>');
    }

    var Viewer = provider.constructor;

    var providerOptions = this._options[id] || {};
    var commonOptions = this._options.common || {};

    return new Viewer({
      ...commonOptions,
      ...providerOptions,
      additionalModules: [
        ...(providerOptions.additionalModules || []), {
          _parent: [ 'value', this ],
          moddle: [ 'value', this._moddle ]
        }
      ]
    });
  }

  /**
   * Emit an event.
   */
  _emit(...args) {
    return this._eventBus.fire(...args);
  }

  _createModdle(options) {
    return new DmnModdle(assign({
      camunda: CamundaModdle
    }, options.moddleExtensions));
  }

  /**
   * Return the list of available view providers.
   *
   * @abstract
   *
   * @return {Array<ViewProvider>}
   */
  _getViewProviders() {
    return [];
  }

}


// helpers //////////////////////

function noop() {}

/**
 * Ensure the passed argument is a proper unit (defaulting to px)
 */
function ensureUnit(val) {
  return val + (isNumber(val) ? 'px' : '');
}

function checkDMNCompatibilityError(err, xml) {

  // check if we can indicate opening of old DMN 1.1 or DMN 1.2 diagrams

  if (err.message !== 'failed to parse document as <dmn:Definitions>') {
    return null;
  }

  var olderDMNVersion = (
    (xml.indexOf('"http://www.omg.org/spec/DMN/20151101/dmn.xsd"') !== -1 && '1.1') ||
    (xml.indexOf('"http://www.omg.org/spec/DMN/20180521/MODEL/"') !== -1 && '1.2')
  );

  if (!olderDMNVersion) {
    return null;
  }

  err = new Error(
    'unsupported DMN ' + olderDMNVersion + ' file detected; ' +
    'only DMN 1.3 files can be opened'
  );

  console.error(
    'Cannot open what looks like a DMN ' + olderDMNVersion + ' diagram. ' +
    'Please refer to https://bpmn.io/l/dmn-compatibility.html ' +
    'to learn how to make the toolkit compatible with older DMN files',
    err
  );

  return err;
}

function checkValidationError(err) {

  // check if we can help the user by indicating wrong DMN 1.3 xml
  // (in case he or the exporting tool did not get that right)

  var pattern = /unparsable content <([^>]+)> detected([\s\S]*)$/,
      match = pattern.exec(err.message);

  if (!match) {
    return null;
  }

  err.message =
    'unparsable content <' + match[ 1 ] + '> detected; ' +
    'this may indicate an invalid DMN 1.3 diagram file' + match[ 2 ];

  return err;
}

function viewsEqual(a, b) {
  if (!isDefined(a)) {
    if (!isDefined(b)) {
      return true;
    } else {
      return false;
    }
  }

  if (!isDefined(b)) {
    return false;
  }

  // compare by element OR element ID equality
  return a.element === b.element || a.id === b.id;
}

function viewNameChanged(a, b) {
  return !a || !b || a.name !== b.name;
}

function safeExecute(viewer, method) {
  if (isFunction(viewer[ method ])) {
    viewer[ method ]();
  }
}
