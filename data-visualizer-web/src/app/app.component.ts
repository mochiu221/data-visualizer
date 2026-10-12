import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, ElementRef, OnInit, ViewChild, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { of } from 'rxjs';

type DatabaseType = 'mssql' | 'mongodb' | 'postgresql' | 'mysql';
type ChartType = 'bar' | 'line' | 'donut' | 'table';
interface Connection { id: string; name: string; type: DatabaseType; host: string; port: number; database: string; username: string; tls: boolean; hasPassword: boolean; status: string; }
interface TableSource { name: string; type: 'table' | 'view' | 'collection'; }
interface JoinDefinition { source: string; leftField: string; rightField: string; type: 'inner' | 'left'; }
interface Visualization { id: string; title: string; source: string; join?: JoinDefinition; type: ChartType; createdAt: string; }
interface FilterControlPreview { field: string; label: string; type: string; operator: string; range?: 'from' | 'to'; category?: boolean; }
interface QueryPlanPreview { select: Array<{ field: string; label?: string }>; filterGroups: Array<Array<{ field: string; operator: string; value: string | number | boolean }>>; groupBy: string[]; sort: { field: string; direction: string } | null; page: number; pageSize: number; }
interface ChartPreview { xAxis: { field: string; label: string; scale: string; timeUnit?: string }; yAxis: { field: string; label: string; scale: string }; yAxes?: Array<{ field: string; label: string; scale: string }>; yAggregation: string; }
interface VisualizationDefinitionPreview { queryPlan: QueryPlanPreview; filterControls: FilterControlPreview[]; selectMode: 'single' | 'multiple'; defaultSelects: string[]; title: string; type: ChartType; chart: ChartPreview; }
interface VisualizationPreview extends Visualization { request: string; connectionId: string; query: string; queryParameters: Array<string | number | boolean>; queryPlan: QueryPlanPreview; filterControls: FilterControlPreview[]; chart: ChartPreview; schema: unknown; }
interface VisualizationDraftResponse { draftId: string; definition: VisualizationDefinitionPreview; visualization: VisualizationPreview; }

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, RouterOutlet],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  @ViewChild('previewPanel') private previewPanel?: ElementRef<HTMLElement>;
  readonly apiUrl = 'http://localhost:3000/api';
  readonly databaseTypes: DatabaseType[] = ['mssql', 'mongodb', 'postgresql', 'mysql'];
  readonly maskedPassword = '********';
  connections: Connection[] = [];
  visualizations: Visualization[] = [];
  private _activeView = 'overview';
  private _notice = '';
  private noticeTimeout?: ReturnType<typeof setTimeout>;
  noticeType: 'success' | 'error' | 'warning' | 'info' = 'info';
  showConnectionForm = false;
  isSaving = false;
  isTestingNewConnection = false;
  isRefreshingStatuses = false;
  isGenerating = false;
  isConfirmingDraft = false;
  testedConnectionFingerprint = '';
  connectionTestMessage = '';
  connectionTestFailed = false;
  apiOnline = false;
  pendingDraftId = '';
  pendingVisualization?: VisualizationPreview;
  pendingDefinition?: VisualizationDefinitionPreview;
  visualizationToDelete?: Visualization;
  connectionToDelete?: Connection;
  connectionMenuId = '';
  editingConnectionId = '';
  schemaColumns: Array<{ name: string; type: string }> = [];
  joinSchemaColumns: Array<{ name: string; type: string }> = [];
  tables: TableSource[] = [];
  isLoadingTables = false;
  isLoadingSchema = false;
  query = { connectionId: '', source: '', request: '' };
  joinSource = '';
  newConnection = { name: '', type: 'mssql' as DatabaseType, host: '', port: 1433, database: '', username: '', password: '', tls: false };
  readonly todayLabel = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date()).toUpperCase();
  get isDetailPage(): boolean { return this.router.url.startsWith('/visualizations/'); }
  get activeView(): string { return this._activeView; }
  get notice(): string { return this._notice; }
  set notice(message: string) {
    if (this.noticeTimeout) clearTimeout(this.noticeTimeout);
    this._notice = message;
    this.noticeType = this.classifyNotice(message);
    if (message) this.noticeTimeout = setTimeout(() => { this._notice = ''; this.noticeTimeout = undefined; }, 5000);
    else this.noticeTimeout = undefined;
  }
  private classifyNotice(message: string): 'success' | 'error' | 'warning' | 'info' {
    if (/\b(could not|failed|offline|invalid|not found|cannot|does not exist|no longer exists|not present|unsupported|error)\b/i.test(message)) return 'error';
    if (/^(select|choose|describe|provide)\b/i.test(message)) return 'warning';
    if (/\b(saved|deleted|updated|connected securely)\b/i.test(message)) return 'success';
    return 'info';
  }
  get selectedConnection(): Connection | undefined { return this.connections.find((connection) => connection.id === this.query.connectionId); }
  set activeView(value: string) {
    if (this._activeView !== value) window.scrollTo(0, 0);
    this._activeView = value;
  }
  get connectionTestPassed(): boolean { return this.testedConnectionFingerprint === JSON.stringify(this.newConnection); }
  selectSummary(definition: VisualizationDefinitionPreview): string {
    return definition.queryPlan.select.length
      ? definition.queryPlan.select.map((selection) => selection.label || selection.field).join(', ')
      : 'All source fields';
  }
  displayFieldsSummary(definition: VisualizationDefinitionPreview): string {
    const defaults = definition.defaultSelects.length ? definition.defaultSelects.join(', ') : 'None';
    return `${definition.selectMode === 'multiple' ? 'Multiple' : 'Single'} · initially showing ${defaults}`;
  }
  dimensionSummary(definition: VisualizationDefinitionPreview): string {
    const axis = definition.chart.xAxis;
    const timeUnit = axis.scale === 'time' && axis.timeUnit ? ` · ${axis.timeUnit}` : '';
    return `${axis.label} · ${axis.field}${timeUnit}`;
  }
  measureSummary(definition: VisualizationDefinitionPreview): string {
    const axes = definition.chart.yAxes?.length ? definition.chart.yAxes : [definition.chart.yAxis];
    return axes.map((axis) => `${axis.label} · ${axis.field}`).join(', ');
  }

  ngOnInit(): void { this.loadConnections(); this.loadVisualizations(); }
  loadConnections(): void { this.http.get<Connection[]>(`${this.apiUrl}/connections`).subscribe({ next: (items) => { this.connections = items; this.apiOnline = true; this.refreshConnectionStatuses(); }, error: () => { this.apiOnline = false; this.notice = 'API is offline. Start the Compose stack to connect live data.'; } }); }
  refreshConnectionStatuses(): void {
    if (!this.connections.length) return;
    this.isRefreshingStatuses = true;
    let pending = this.connections.length;
    const complete = () => { pending -= 1; if (!pending) this.isRefreshingStatuses = false; };
    for (const connection of this.connections) {
      this.updateConnectionStatus(connection.id, 'Checking...');
      this.http.post<{ ok: boolean }>(`${this.apiUrl}/connections/${connection.id}/test`, {}).subscribe({
        next: (result) => { this.updateConnectionStatus(connection.id, result.ok ? 'Connected' : 'Offline'); complete(); },
        error: () => { this.updateConnectionStatus(connection.id, 'Offline'); complete(); }
      });
    }
  }
  private updateConnectionStatus(id: string, status: string): void { this.connections = this.connections.map((connection) => connection.id === id ? { ...connection, status } : connection); }
  loadVisualizations(): void { this.http.get<Visualization[]>(`${this.apiUrl}/visualizations`).subscribe({ next: (items) => this.visualizations = items, error: () => undefined }); }
  loadSchema(): void {
    if (!this.query.connectionId || !this.query.source.trim()) { this.schemaColumns = []; return; }
    this.isLoadingSchema = true;
    this.http.get<{ columns: Array<{ name: string; type: string }> }>(`${this.apiUrl}/schema/${this.query.connectionId}?source=${encodeURIComponent(this.query.source.trim())}`).subscribe({
      next: (result) => { this.schemaColumns = result.columns; this.isLoadingSchema = false; },
      error: (response) => { this.schemaColumns = []; this.isLoadingSchema = false; this.notice = response.error?.message ?? 'Could not read the source schema.'; }
    });
  }
  loadJoinSchema(): void {
    if (!this.query.connectionId || !this.joinSource.trim()) { this.joinSchemaColumns = []; return; }
    this.http.get<{ columns: Array<{ name: string; type: string }> }>(`${this.apiUrl}/schema/${this.query.connectionId}?source=${encodeURIComponent(this.joinSource.trim())}`).subscribe({
      next: (result) => { this.joinSchemaColumns = result.columns; },
      error: (response) => { this.joinSchemaColumns = []; this.notice = response.error?.message ?? 'Could not read the joined source schema.'; }
    });
  }
  selectConnection(): void {
    this.query.source = '';
    this.joinSource = '';
    this.tables = [];
    this.schemaColumns = [];
    this.joinSchemaColumns = [];
    if (!this.query.connectionId) return;
    this.isLoadingTables = true;
    this.http.get<{ tables: TableSource[] }>(`${this.apiUrl}/tables/${this.query.connectionId}`).subscribe({
      next: (result) => { this.tables = result.tables; this.isLoadingTables = false; },
      error: (response) => { this.isLoadingTables = false; this.notice = response.error?.message ?? 'Could not list tables for that connection.'; }
    });
  }
  saveConnection(): void {
    this.isSaving = true;
    this.isTestingNewConnection = true;
    this.testedConnectionFingerprint = '';
    this.connectionTestMessage = '';
    this.connectionTestFailed = false;
    const retainingPassword = this.editingConnectionId && (this.newConnection.password === this.maskedPassword || !this.newConnection.password);
    const connectionPayload = { ...this.newConnection, password: retainingPassword ? '' : this.newConnection.password };
    const connectionTest = retainingPassword ? of({ message: 'Existing password retained.' }) : this.http.post<{ message: string }>(`${this.apiUrl}/connections/test`, connectionPayload);
    connectionTest.subscribe({
      next: (result) => {
        this.isTestingNewConnection = false;
        this.testedConnectionFingerprint = JSON.stringify(connectionPayload);
        this.connectionTestMessage = result.message;
        const request = this.editingConnectionId ? this.http.put<Connection>(`${this.apiUrl}/connections/${this.editingConnectionId}`, connectionPayload) : this.http.post<Connection>(`${this.apiUrl}/connections`, connectionPayload);
        request.subscribe({
          next: (connection) => { this.connections = this.editingConnectionId ? this.connections.map((item) => item.id === connection.id ? connection : item) : [connection, ...this.connections]; this.loadConnections(); this.query.connectionId = connection.id; this.selectConnection(); this.closeConnectionForm(); this.isSaving = false; this.notice = this.editingConnectionId ? 'Connection updated securely.' : 'Connection saved securely.'; },
          error: () => { this.isSaving = false; this.notice = 'Could not save that connection.'; }
        });
      },
      error: (response) => { this.isSaving = false; this.isTestingNewConnection = false; this.connectionTestFailed = true; this.connectionTestMessage = response.error?.message ?? 'Connection test failed.'; this.notice = this.connectionTestMessage; }
    });
  }
  editConnection(connection: Connection): void {
    this.connectionMenuId = '';
    this.editingConnectionId = connection.id;
    this.newConnection = { name: connection.name, type: connection.type, host: connection.host, port: connection.port, database: connection.database, username: connection.username, password: connection.hasPassword ? this.maskedPassword : '', tls: connection.tls };
    this.testedConnectionFingerprint = '';
    this.connectionTestMessage = '';
    this.connectionTestFailed = false;
    this.showConnectionForm = true;
  }
  clearPasswordPlaceholder(): void { if (this.newConnection.password === this.maskedPassword) this.newConnection.password = ''; }
  restorePasswordPlaceholder(): void { if (this.editingConnectionId && !this.newConnection.password) this.newConnection.password = this.maskedPassword; }
  openNewConnectionForm(): void {
    this.editingConnectionId = '';
    this.newConnection = { name: '', type: 'mssql', host: '', port: 1433, database: '', username: '', password: '', tls: false };
    this.testedConnectionFingerprint = '';
    this.connectionTestMessage = '';
    this.connectionTestFailed = false;
    this.showConnectionForm = true;
  }
  closeConnectionForm(): void { this.showConnectionForm = false; this.editingConnectionId = ''; }
  requestDeleteConnection(connection: Connection): void { this.connectionMenuId = ''; this.connectionToDelete = connection; }
  cancelDeleteConnection(): void { this.connectionToDelete = undefined; }
  deleteConnection(): void {
    const connection = this.connectionToDelete;
    if (!connection) return;
    this.http.delete(`${this.apiUrl}/connections/${connection.id}`).subscribe({
      next: () => { this.connections = this.connections.filter((item) => item.id !== connection.id); if (this.query.connectionId === connection.id) { this.query.connectionId = ''; this.query.source = ''; this.tables = []; this.schemaColumns = []; } this.connectionToDelete = undefined; this.notice = 'Connection deleted.'; },
      error: (response) => { this.notice = response.error?.message ?? 'Could not delete the connection.'; }
    });
  }
  generateVisualization(): void {
    if (!this.query.connectionId) { this.notice = 'Select a saved database connection first.'; return; }
    if (!this.query.source.trim()) { this.notice = 'Select a table or collection before creating a visualization.'; return; }
    if (!this.query.request.trim()) { this.notice = 'Describe what you want to see before creating a visualization.'; return; }
    const join = this.joinSource.trim() ? { source: this.joinSource.trim() } : undefined;
    this.isGenerating = true;
    this.previewPanel?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    this.http.post<VisualizationDraftResponse>(`${this.apiUrl}/visualizations/generate`, { ...this.query, ...(join ? { join } : {}), title: this.query.request }).subscribe({ next: (draft) => { this.pendingDraftId = draft.draftId; this.pendingDefinition = draft.definition; this.pendingVisualization = draft.visualization; this.isGenerating = false; this.notice = 'Review the generated definition before saving it.'; }, error: (response) => { this.isGenerating = false; this.notice = response.error?.message ?? 'The visualization definition could not be generated.'; } });
  }
  confirmVisualization(): void {
    if (!this.pendingDraftId) return;
    this.isConfirmingDraft = true;
    this.http.post<Visualization>(`${this.apiUrl}/visualizations/confirm`, { draftId: this.pendingDraftId }).subscribe({
      next: (visualization) => { this.visualizations = [visualization, ...this.visualizations]; this.pendingDraftId = ''; this.pendingDefinition = undefined; this.pendingVisualization = undefined; this.isConfirmingDraft = false; void this.router.navigate(['/visualizations', visualization.id]); },
      error: (response) => { this.isConfirmingDraft = false; this.notice = response.error?.message ?? 'Could not save the visualization.'; }
    });
  }
  discardVisualizationDraft(): void { this.pendingDraftId = ''; this.pendingDefinition = undefined; this.pendingVisualization = undefined; this.notice = ''; }
  requestDeleteVisualization(visualization: Visualization): void { this.visualizationToDelete = visualization; }
  cancelDeleteVisualization(): void { this.visualizationToDelete = undefined; }
  deleteVisualization(): void {
    const visualization = this.visualizationToDelete;
    if (!visualization) return;
    this.http.delete(`${this.apiUrl}/visualizations/${visualization.id}`).subscribe({
      next: () => { this.visualizations = this.visualizations.filter((item) => item.id !== visualization.id); this.visualizationToDelete = undefined; this.notice = 'Visualization deleted.'; },
      error: (response) => { this.notice = response.error?.message ?? 'Could not delete the visualization.'; }
    });
  }
  iconFor(type: DatabaseType): string { return type === 'mongodb' ? '◇' : type === 'mssql' ? '▦' : type === 'mysql' ? '◈' : '◉'; }
  chartValue(item: Record<string, string | number>): number { return Number(Object.values(item).find((value) => typeof value === 'number') ?? 0); }
  chartLabel(item: Record<string, string | number>): string { return String(Object.values(item).find((value) => typeof value === 'string') ?? ''); }
}
