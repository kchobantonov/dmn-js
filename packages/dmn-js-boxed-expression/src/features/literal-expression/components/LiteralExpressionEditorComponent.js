import { Component } from 'inferno';

import { getBoxedExpression } from 'dmn-js-shared/lib/util/ModelUtil';

import EditableComponent from 'dmn-js-shared/lib/components/EditableComponent';
import LiteralExpression from 'dmn-js-shared/lib/components/LiteralExpression';


export default class LiteralExpressionEditorComponent extends Component {
  constructor(props, context) {
    super(props, context);

    this._modeling = context.injector.get('modeling');

    this._viewer = context.injector.get('viewer');
    this._expressionLanguages = context.injector.get('expressionLanguages');
    this._variableResolver = context.injector.get('variableResolver', false);

    this.editLiteralExpressionText = this.editLiteralExpressionText.bind(this);
    this.onElementsChanged = this.onElementsChanged.bind(this);

    // there is only one single element
    const { id } = this.getLiteralExpression();

    context.changeSupport.onElementsChanged(id, this.onElementsChanged);
  }

  getLiteralExpression() {
    return getBoxedExpression(this._viewer.getRootElement());
  }

  onElementsChanged() {
    this.forceUpdate();
  }

  editLiteralExpressionText(text) {
    const literalExpression = this.getLiteralExpression();

    this._modeling.updateProperties(literalExpression, { text });
  }

  getEditor() {
    return this.isFeel() ? FeelEditor : Editor;
  }

  isFeel() {
    return this.getExpressionLanguage() === 'feel';
  }

  getExpressionLanguage() {
    const businessObject = this.getLiteralExpression();

    return businessObject.expressionLanguage ||
      this._expressionLanguages.getDefault().value;
  }

  _getVariables() {
    const businessObject = this.getLiteralExpression();

    return this._variableResolver &&
      this._variableResolver.getVariables(businessObject);
  }

  render() {

    // there is only one single element
    const { text } = this.getLiteralExpression();
    const Editor = this.getEditor();
    const variables = this._getVariables();

    return (
      <Editor
        className="textarea editor"
        value={ text }
        onChange={ this.editLiteralExpressionText }
        variables={ variables } />
    );
  }
}

class FeelEditor extends Component {
  render() {
    return <LiteralExpression
      className={ this.props.className }
      value={ this.props.value }
      onInput={ this.props.onChange }
      variables={ this.props.variables }
    />;
  }
}

class Editor extends EditableComponent {

  render() {

    return (
      <div className={ this.getClassName() }>
        { this.getEditor() }
      </div>
    );
  }

}