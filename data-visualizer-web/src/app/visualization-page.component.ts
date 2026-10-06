import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, ElementRef, OnDestroy, OnInit, ViewChild, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { CategoryScale, Chart, Filler, Legend, LineController, LineElement, LinearScale, PointElement, TimeScale, Tooltip } from 'chart.js';
import 'chartjs-adapter-date-fns';

Chart.register(CategoryScale, Filler, Legend, LineController, LineElement, LinearScale, PointElement, TimeScale, Tooltip);

interface Visualization {
  id: string;
  title: string;
  request: string;
  query?: string;
  queryParameters?: Array<string | number | boolean>;
  source: string;
  type: 'bar' | 'line' | 'donut' | 'table';
  data: Array<Record<string, string | number>>;
  schema?: Array<{ name: string; type: string }>;
  chart?: { xAxis: { field: string; label: string; scale?: 'category' | 'time'; timeUnit?: 'millisecond' | 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year' }; yAxis: { field: string; label: string; scale?: 'category' | 'time' }; yAggregation: string };
  filterControls: Array<{ field: string; label: string; type: 'text' | 'number' | 'boolean' | 'date' | 'time' | 'datetime'; operator: string; range?: 'from' | 'to' }>;
  queryPlan?: { page: number; pageSize: number; filters: Array<{ field: string; operator: string; value: string | number | boolean }>; sort: { field: string; direction: string } | null };
}
type FilterValue = string | number | boolean | null;

@Component({
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: 'visualization-page.component.html',
  styleUrls: ['./visualization-page.component.css']
})
export class VisualizationPageComponent implements OnDestroy, OnInit {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  readonly apiUrl = 'http://localhost:3000/api';
  visualization?: Visualization;
  loading = true;
  error = '';
  filterValues: Record<string, FilterValue> = {};
  private lineCanvas?: ElementRef<HTMLCanvasElement>;
  private lineChart?: Chart<'line', number[] | Array<{ x: string; y: number }>, string>;

  @ViewChild('lineCanvas')
  set lineCanvasElement(value: ElementRef<HTMLCanvasElement> | undefined) {
    this.lineCanvas = value;
    if (value) this.scheduleLineChartRender();
  }

  filterKey(control: Visualization['filterControls'][number]): string {
    return `${control.field}::${control.operator}`;
  }

  ngOnInit(): void {
    this.route.paramMap.subscribe((params) => {
      const id = params.get('id');
      this.loadVisualization(id);
    });
  }

  ngOnDestroy(): void { this.lineChart?.destroy(); }

  loadVisualization(id: string | null): void {
    this.visualization = undefined;
    this.error = '';
    if (!id) { this.error = 'Visualization not found.'; this.loading = false; return; }
    this.loading = true;
    this.http.get<Visualization>(`${this.apiUrl}/visualizations/${id}`).subscribe({
      next: (item) => { this.visualization = item; this.filterValues = Object.fromEntries(item.filterControls.map((control) => [this.filterKey(control), null])); this.loading = false; this.scheduleLineChartRender(); },
      error: (response) => { this.error = response.status === 404 ? 'Visualization not found.' : response.error?.message ?? 'Could not load the visualization.'; this.loading = false; }
    });
  }

  applyFilters(): void {
    if (!this.visualization) return;
    this.loading = true;
    this.error = '';
    this.http.post<Visualization>(`${this.apiUrl}/visualizations/${this.visualization.id}/query`, { filters: this.filterValues }).subscribe({
      next: (item) => { this.visualization = item; this.loading = false; this.scheduleLineChartRender(); },
      error: (response) => { this.error = response.error?.message ?? 'Could not apply filters.'; this.loading = false; }
    });
  }

  clearFilters(): void {
    for (const field of Object.keys(this.filterValues)) this.filterValues[field] = null;
    this.applyFilters();
  }

  setFilterValue(control: Visualization['filterControls'][number], value: FilterValue): void {
    this.filterValues[this.filterKey(control)] = value;
  }

  filterGroups(): Array<{ key: string; controls: Visualization['filterControls'] }> {
    const groups = new Map<string, Visualization['filterControls']>();
    for (const control of this.visualization?.filterControls ?? []) {
      const key = this.isRangeControl(control) ? `range::${control.field}` : this.filterKey(control);
      groups.set(key, [...(groups.get(key) ?? []), control]);
    }
    return [...groups.entries()].map(([key, controls]) => ({ key, controls }));
  }

  isRangeControl(control: Visualization['filterControls'][number]): boolean {
    return Boolean(control.range) || (['number', 'date', 'datetime'].includes(control.type) && ['gt', 'gte', 'lt', 'lte'].includes(control.operator));
  }

  private scheduleLineChartRender(): void {
    setTimeout(() => this.renderLineChart());
  }

  private renderLineChart(): void {
    if (this.visualization?.type !== 'line' || !this.lineCanvas) {
      this.lineChart?.destroy();
      this.lineChart = undefined;
      return;
    }
    this.lineChart?.destroy();
    this.lineChart = new Chart(this.lineCanvas.nativeElement, {
      type: 'line',
      data: {
        labels: this.visualization.chart?.xAxis.scale === 'time' ? undefined : this.visualization.data.map((item) => this.chartLabel(item)),
        datasets: [{
          data: this.visualization.chart?.xAxis.scale === 'time'
            ? this.visualization.data.map((item) => ({ x: this.chartTimeValue(item), y: this.chartValue(item) }))
            : this.visualization.data.map((item) => this.chartValue(item)),
          borderColor: '#1f7055',
          backgroundColor: 'rgba(31, 112, 85, .08)',
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 5,
          pointBackgroundColor: '#e27845',
          pointBorderColor: '#ffffff',
          pointBorderWidth: 2,
          tension: .28,
          fill: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: { display: false },
          tooltip: { displayColors: false, padding: 10 }
        },
        scales: {
          x: {
            type: this.visualization.chart?.xAxis.scale === 'time' ? 'time' : 'category',
            title: { display: true, text: this.visualization.chart?.xAxis.label ?? 'X axis', color: '#718078', font: { size: 11, weight: 600 } },
            grid: { display: false },
            border: { display: false },
            time: { unit: this.visualization.chart?.xAxis.timeUnit ?? 'day' },
            ticks: { color: '#718078', maxRotation: 0, autoSkip: true, padding: 8 }
          },
          y: {
            beginAtZero: true,
            title: { display: true, text: this.visualization.chart?.yAxis.label ?? 'Value', color: '#718078', font: { size: 11, weight: 600 } },
            grid: { color: '#e8efeb' },
            border: { display: false },
            ticks: { color: '#718078', padding: 8, precision: 0 }
          }
        }
      }
    });
  }

  trackFilterControl(_index: number, control: Visualization['filterControls'][number]): string {
    return `${control.field}::${control.operator}`;
  }

  trackFilterGroup(_index: number, group: { key: string }): string { return group.key; }

  chartValue(item: Record<string, string | number>): number { const field = this.visualization?.chart?.yAxis.field; return Number(field ? item[field] ?? 0 : Object.values(item).find((value) => typeof value === 'number') ?? 0); }
  displayValue(value: string | number): string {
    if (typeof value !== 'string') return String(value);
    try { const parsed = JSON.parse(value); return typeof parsed === 'string' ? parsed : value; } catch { return value.replace(/^"|"$/g, ''); }
  }
  chartLabel(item: Record<string, string | number>): string { const field = this.visualization?.chart?.xAxis.field; return this.displayValue(field ? item[field] ?? '' : Object.values(item).find((value) => typeof value === 'string') ?? ''); }
  chartTimeValue(item: Record<string, string | number>): string { return this.chartLabel(item).replace(/Z$/, ''); }
  donutTotal(): number { return (this.visualization?.data ?? []).reduce((total, item) => total + Math.max(this.chartValue(item), 0), 0); }
  donutGradient(): string {
    const colors = ['#2b805d', '#d77b43', '#73b58e', '#c65d4c', '#4e7891', '#b38b4a'];
    const total = this.donutTotal();
    if (!total) return 'conic-gradient(#dce9df 0 100%)';
    let offset = 0;
    const segments = (this.visualization?.data ?? []).map((item, index) => {
      const next = offset + (Math.max(this.chartValue(item), 0) / total) * 100;
      const segment = `${colors[index % colors.length]} ${offset}% ${next}%`;
      offset = next;
      return segment;
    });
    return `conic-gradient(${segments.join(', ')})`;
  }
  donutPercent(item: Record<string, string | number>): number { const total = this.donutTotal(); return total ? Math.round((Math.max(this.chartValue(item), 0) / total) * 100) : 0; }
  keys(): string[] { return this.visualization?.data[0] ? Object.keys(this.visualization.data[0]) : []; }
  sortSummary(): string { const sort = this.visualization?.queryPlan?.sort; return sort ? `${sort.field} ${sort.direction}` : 'Default order'; }
  queryParameterName(index: number): string { return `p${index}`; }
  queryParameterValue(value: string | number | boolean): string { return typeof value === 'string' ? JSON.stringify(value) : String(value); }
}
