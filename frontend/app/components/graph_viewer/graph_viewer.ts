import {PlatformLocation} from '@angular/common';
import {Component, ElementRef, OnDestroy, ViewChild} from '@angular/core';
import {ActivatedRoute} from '@angular/router';
import {Store} from '@ngrx/store';
import {API_PREFIX, DATA_API, DIAGNOSTICS_DEFAULT, GRAPH_CONFIG_KEYS, PLUGIN_NAME} from 'org_xprof/frontend/app/common/constants/constants';
import {Diagnostics} from 'org_xprof/frontend/app/common/interfaces/diagnostics';
import {GraphConfigInput, GraphViewerQueryParams} from 'org_xprof/frontend/app/common/interfaces/graph_viewer';
import {NavigationEvent} from 'org_xprof/frontend/app/common/interfaces/navigation_event';
import {GraphConfig} from 'org_xprof/frontend/app/components/graph_viewer/graph_config/graph_config';
import {setCurrentToolStateAction} from 'org_xprof/frontend/app/store/actions';
import {ReplaySubject} from 'rxjs';
import {takeUntil} from 'rxjs/operators';

const GRAPH_HTML_THRESHOLD = 1000000;  // bytes

/** A graph viewer component. */
@Component({
  selector: 'graph-viewer',
  templateUrl: './graph_viewer.ng.html',
  styleUrls: ['./graph_viewer.scss'],
})
export class GraphViewer implements OnDestroy {
  readonly tool = 'graph_viewer';
  /** Handles on-destroy Subject, used to unsubscribe. */
  private readonly destroyed = new ReplaySubject<void>(1);

  @ViewChild(GraphConfig) config!: GraphConfig;
  @ViewChild('iframe', {static: false})
  graphRef!: ElementRef<HTMLIFrameElement>;

  run = '';
  tag = 'graph_viewer';
  host = '';
  /** The hlo module list. */
  moduleList: string[] = [];
  initialParams: GraphConfigInput|undefined = undefined;
  selectedModule = '';
  opName = '';
  graphWidth = 3;
  showMetadata = false;
  mergeFusion = false;
  /** The graphviz url. */
  url = '';
  diagnostics: Diagnostics = {...DIAGNOSTICS_DEFAULT};
  loadingGraphHtml = false;
  graphvizUri = '';
  pathPrefix = '';

  constructor(
      private readonly route: ActivatedRoute,
      private readonly store: Store<{}>,
      platformLocation: PlatformLocation,
  ) {
    this.route.params.pipe(takeUntil(this.destroyed)).subscribe((params) => {
      this.update(params as NavigationEvent);
    });
    this.store.dispatch(setCurrentToolStateAction({currentTool: this.tag}));
    if (String(platformLocation.pathname).includes(API_PREFIX + PLUGIN_NAME)) {
      this.pathPrefix =
          String(platformLocation.pathname).split(API_PREFIX + PLUGIN_NAME)[0];
    }
  }

  update(event: NavigationEvent) {
    this.run = event.run || '';
    this.tag = event.tag || 'graph_viewer';
    this.host = event.host || '';
    // host equals to module name for graph viewer
    this.selectedModule = this.host;
    this.opName = event.paramsOpName || this.opName;
    this.initialParams = this.getParams();
    this.onPlot();
  }

  // Function called whenever user click the search graph button
  onSearchGraph(params: Partial<GraphConfigInput>) {
    this.updateParams(params);
    this.resetPage();
    this.onPlot();
    // Reload iframe to re-inject html body
    // Compensate the effect of `clearGraphIframeHtml` in resetPage
    const iframe = document.getElementById('graph-html') as HTMLIFrameElement;
    iframe.contentWindow!.location.reload();
  }

  getParams(): GraphConfigInput {
    return {
      selectedModule: this.selectedModule,
      opName: this.opName,
      graphWidth: this.graphWidth,
      showMetadata: this.showMetadata,
      mergeFusion: this.mergeFusion,
    };
  }

  updateParams(param: Partial<GraphConfigInput>) {
    Object.entries(param).forEach(([key, value]) => {
      if (GRAPH_CONFIG_KEYS.includes(key)) {
        Object.assign(this, {[key]: value});
      }
    });
  }

  validToPlot() {
    return this.opName && this.selectedModule;
  }

  onPlot() {
    if (!this.validToPlot()) return;

    this.loadingGraphHtml = true;
    // Update the query parameters in url after form updates
    const queryParams: GraphViewerQueryParams = {
      'node_name': this.opName,
      'module_name': this.selectedModule,
      'graph_width': this.graphWidth,
      'show_metadata': this.showMetadata,
      'merge_fusion': this.mergeFusion,
    };

    this.graphvizUri = this.getGraphvizUri(queryParams);
    this.onCheckGraphHtmlLoaded();
  }

  getGraphvizUri(queryParams: GraphViewerQueryParams) {
    const searchParams = new URLSearchParams();
    // Replace session_id with run
    searchParams.set('run', this.run);
    searchParams.set('tag', this.tag);
    searchParams.set('host', this.host);
    for (const [key, value] of Object.entries(queryParams)) {
      searchParams.set(key, value.toString());
    }

    searchParams.set('format', 'html');
    searchParams.set('type', 'graph');
    return `${window.origin}/${this.pathPrefix}/${DATA_API}?${
        searchParams.toString()}`;
  }

  getGraphIframeDocument() {
    return this.graphRef?.nativeElement?.contentDocument;
  }

  graphIframeLoaded() {
    const doc = this.getGraphIframeDocument();
    if (!doc) return false;
    // This is the feature we observed from html/svg generated by
    // third_party/tensorflow/compiler/xla/service/hlo_graph_dumper.cc to
    // determine if the graph has been loaded completedly.
    // We need add a test to detect the breaking change ahread.
    const loadingIdentifierNode = (doc.getElementsByTagName('head') || [])[0];
    return loadingIdentifierNode && loadingIdentifierNode.childElementCount > 0;
  }

  // Append diagnostic message after data loaded for each sections
  onCompleteLoad(diagnostics?: Diagnostics) {
    this.diagnostics = {
      info: [
        ...this.diagnostics.info,
        ...(diagnostics?.info || []),
      ],
      errors: [
        ...this.diagnostics.errors,
        ...(diagnostics?.errors || []),
      ],
      warnings: [
        ...this.diagnostics.warnings,
        ...(diagnostics?.warnings || []),
      ],
    };
  }

  clearGraphIframeHtml() {
    const doc = this.getGraphIframeDocument();
    if (!doc) return;
    doc.firstElementChild?.remove();
  }

  onCheckGraphHtmlLoaded() {
    if (!this.graphIframeLoaded()) {
      setTimeout(() => {
        this.onCheckGraphHtmlLoaded();
      }, 1000);
      return;
    } else {
      this.loadingGraphHtml = false;
      const htmlSize =
          (document.getElementById('graph-html') as HTMLIFrameElement)
              .contentDocument!.documentElement.innerHTML.length;
      if (htmlSize > GRAPH_HTML_THRESHOLD) {
        this.onCompleteLoad({
          warnings: [
            'Your graph is large. If you can\'t see the graph, please lower the width and retry.'
          ]
        } as Diagnostics);
      }
    }
  }

  // Resetting url, iframe, diagnostic messages per graph search
  resetPage() {
    // Clear iframe html so the rule to detect `graphIframeLoaded` can satisfy
    this.clearGraphIframeHtml();
    this.diagnostics = {...DIAGNOSTICS_DEFAULT};
  }

  ngOnDestroy() {
    // Unsubscribes all pending subscriptions.
    this.destroyed.next();
    this.destroyed.complete();
  }
}
