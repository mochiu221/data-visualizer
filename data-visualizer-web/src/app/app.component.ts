import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { of } from 'rxjs';

type DatabaseType = 'mssql' | 'mongodb' | 'postgresql' | 'mysql';
type ChartType = 'bar' | 'line' | 'donut' | 'table';
interface Connection { id: string; name: string; type: DatabaseType; host: string; port: number; database: string; username: string; tls: boolean; status: string; }
interface TableSource { name: string; type: 'table' | 'view' | 'collection'; }
interface Visualization { id: string; title: string; source: string; type: ChartType; createdAt: string; }
interface FilterControlPreview { field: string; label: string; type: string; operator: string; range?: 'from' | 'to'; }
interface QueryPlanPreview { filters: Array<{ field: string; operator: string; value: string | number | boolean }>; groupBy: string[]; sort: { field: string; direction: string } | null; page: number; pageSize: number; }
interface ChartPreview { xAxis: { field: string; label: string; scale: string; timeUnit?: string }; yAxis: { field: string; label: string; scale: string }; yAggregation: string; }
interface VisualizationDefinitionPreview { queryPlan: QueryPlanPreview; filterControls: FilterControlPreview[]; title: string; type: ChartType; chart: ChartPreview; }
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
  readonly apiUrl = 'http://localhost:3000/api';
  readonly databaseTypes: DatabaseType[] = ['mssql', 'mongodb', 'postgresql', 'mysql'];
  readonly maskedPassword = '********';
  connections: Connection[] = [];
  visualizations: Visualization[] = [];
  activeView = 'overview';
  showConnectionForm = false;
  isSaving = false;
  isTestingNewConnection = false;
  isGenerating = false;
  isConfirmingDraft = false;
  testedConnectionFingerprint = '';
  connectionTestMessage = '';
  connectionTestFailed = false;
  apiOnline = false;
  notice = '';
  pendingDraftId = '';
  pendingVisualization?: VisualizationPreview;
  pendingDefinition?: VisualizationDefinitionPreview;
  visualizationToDelete?: Visualization;
  connectionToDelete?: Connection;
  connectionMenuId = '';
  editingConnectionId = '';
  schemaColumns: Array<{ name: string; type: string }> = [];
  tables: TableSource[] = [];
  isLoadingTables = false;
  isLoadingSchema = false;
  query = { connectionId: '', source: '', request: '' };
  newConnection = { name: '', type: 'mssql' as DatabaseType, host: '', port: 1433, database: '', username: '', password: '', tls: false };
  readonly todayLabel = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date()).toUpperCase();
  get isDetailPage(): boolean { return this.router.url.startsWith('/visualizations/'); }
  get connectionTestPassed(): boolean { return this.testedConnectionFingerprint === JSON.stringify(this.newConnection); }

  ngOnInit(): void { this.loadConnections(); this.loadVisualizations(); }
  loadConnections(): void { this.http.get<Connection[]>(`${this.apiUrl}/connections`).subscribe({ next: (items) => { this.connections = items; this.apiOnline = true; }, error: () => { this.apiOnline = false; this.notice = 'API is offline. Start the Compose stack to connect live data.'; } }); }
  loadVisualizations(): void { this.http.get<Visualization[]>(`${this.apiUrl}/visualizations`).subscribe({ next: (items) => this.visualizations = items, error: () => undefined }); }
  loadSchema(): void {
    if (!this.query.connectionId || !this.query.source.trim()) { this.schemaColumns = []; return; }
    this.isLoadingSchema = true;
    this.http.get<{ columns: Array<{ name: string; type: string }> }>(`${this.apiUrl}/schema/${this.query.connectionId}?source=${encodeURIComponent(this.query.source.trim())}`).subscribe({
      next: (result) => { this.schemaColumns = result.columns; this.isLoadingSchema = false; },
      error: (response) => { this.schemaColumns = []; this.isLoadingSchema = false; this.notice = response.error?.message ?? 'Could not read the source schema.'; }
    });
  }
  selectConnection(): void {
    this.query.source = '';
    this.tables = [];
    this.schemaColumns = [];
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
          next: (connection) => { this.connections = this.editingConnectionId ? this.connections.map((item) => item.id === connection.id ? connection : item) : [connection, ...this.connections]; this.query.connectionId = connection.id; this.selectConnection(); this.closeConnectionForm(); this.isSaving = false; this.notice = this.editingConnectionId ? 'Connection updated securely.' : 'Connection saved securely.'; },
          error: () => { this.isSaving = false; this.notice = 'Could not save that connection.'; }
        });
      },
      error: (response) => { this.isSaving = false; this.isTestingNewConnection = false; this.connectionTestFailed = true; this.connectionTestMessage = response.error?.message ?? 'Connection test failed.'; this.notice = this.connectionTestMessage; }
    });
  }
  editConnection(connection: Connection): void {
    this.connectionMenuId = '';
    this.editingConnectionId = connection.id;
    this.newConnection = { name: connection.name, type: connection.type, host: connection.host, port: connection.port, database: connection.database, username: connection.username, password: this.maskedPassword, tls: connection.tls };
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
    this.isGenerating = true;
    this.http.post<VisualizationDraftResponse>(`${this.apiUrl}/visualizations/generate`, { ...this.query, title: this.query.request }).subscribe({ next: (draft) => { this.pendingDraftId = draft.draftId; this.pendingDefinition = draft.definition; this.pendingVisualization = draft.visualization; this.isGenerating = false; this.notice = 'Review the generated definition before saving it.'; }, error: (response) => { this.isGenerating = false; this.notice = response.error?.message ?? 'The visualization definition could not be generated.'; } });
  }
  confirmVisualization(): void {
    if (!this.pendingDraftId) return;
    this.isConfirmingDraft = true;
    this.http.post<Visualization>(`${this.apiUrl}/visualizations/confirm`, { draftId: this.pendingDraftId }).subscribe({
      next: (visualization) => { this.visualizations = [visualization, ...this.visualizations]; this.pendingDraftId = ''; this.pendingDefinition = undefined; this.pendingVisualization = undefined; this.isConfirmingDraft = false; this.activeView = 'overview'; this.notice = 'Visualization saved.'; },
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
