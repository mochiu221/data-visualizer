import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink, RouterOutlet } from '@angular/router';

type DatabaseType = 'mssql' | 'mongodb' | 'postgresql' | 'mysql';
type ChartType = 'bar' | 'line' | 'donut' | 'table';
interface Connection { id: string; name: string; type: DatabaseType; host: string; port: number; database: string; status: string; }
interface TableSource { name: string; type: 'table' | 'view' | 'collection'; }
interface Visualization { id: string; title: string; source: string; type: ChartType; }

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
  connections: Connection[] = [];
  visualizations: Visualization[] = [];
  activeView = 'overview';
  showConnectionForm = false;
  isSaving = false;
  isTestingNewConnection = false;
  isGenerating = false;
  testedConnectionFingerprint = '';
  connectionTestMessage = '';
  connectionTestFailed = false;
  apiOnline = false;
  notice = '';
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
    this.http.post<{ message: string }>(`${this.apiUrl}/connections/test`, this.newConnection).subscribe({
      next: (result) => {
        this.isTestingNewConnection = false;
        this.testedConnectionFingerprint = JSON.stringify(this.newConnection);
        this.connectionTestMessage = result.message;
        this.http.post<Connection>(`${this.apiUrl}/connections`, this.newConnection).subscribe({
          next: (connection) => { this.connections = [connection, ...this.connections]; this.query.connectionId = connection.id; this.selectConnection(); this.showConnectionForm = false; this.isSaving = false; this.notice = 'Connection saved securely.'; },
          error: () => { this.isSaving = false; this.notice = 'Could not save that connection.'; }
        });
      },
      error: (response) => { this.isSaving = false; this.isTestingNewConnection = false; this.connectionTestFailed = true; this.connectionTestMessage = response.error?.message ?? 'Connection test failed.'; this.notice = this.connectionTestMessage; }
    });
  }
  generateVisualization(): void {
    if (!this.query.connectionId) { this.notice = 'Select a saved database connection first.'; return; }
    if (!this.query.source.trim()) { this.notice = 'Select a table or collection before creating a visualization.'; return; }
    if (!this.query.request.trim()) { this.notice = 'Describe what you want to see before creating a visualization.'; return; }
    this.isGenerating = true;
    this.http.post<Visualization>(`${this.apiUrl}/visualizations/generate`, { ...this.query, title: this.query.request }).subscribe({ next: (visualization) => { this.visualizations = [visualization, ...this.visualizations]; this.isGenerating = false; this.activeView = 'overview'; this.notice = 'Visualization generated from a live database query.'; }, error: (response) => { this.isGenerating = false; this.notice = response.error?.message ?? 'The database preview or visualization could not be generated.'; } });
  }
  deleteVisualization(id: string): void { this.http.delete(`${this.apiUrl}/visualizations/${id}`).subscribe({ next: () => this.visualizations = this.visualizations.filter((item) => item.id !== id) }); }
  iconFor(type: DatabaseType): string { return type === 'mongodb' ? '◇' : type === 'mssql' ? '▦' : type === 'mysql' ? '◈' : '◉'; }
  chartValue(item: Record<string, string | number>): number { return Number(Object.values(item).find((value) => typeof value === 'number') ?? 0); }
  chartLabel(item: Record<string, string | number>): string { return String(Object.values(item).find((value) => typeof value === 'string') ?? ''); }
}
