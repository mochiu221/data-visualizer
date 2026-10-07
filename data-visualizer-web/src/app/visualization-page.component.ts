import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, ElementRef, OnDestroy, OnInit, ViewChild, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { BarController, BarElement, CategoryScale, Chart, Filler, Legend, LineController, LineElement, LinearScale, PointElement, TimeScale, Tooltip } from 'chart.js';
import 'chartjs-adapter-date-fns';

Chart.register(BarController, BarElement, CategoryScale, Filler, Legend, LineController, LineElement, LinearScale, PointElement, TimeScale, Tooltip);

interface Visualization {
  id: string;
  title: string;
  request: string;
  query?: string;
  queryParameters?: Array<string | number | boolean>;
  total?: number;
  pagination?: { page: number; pageSize: number; total: number; totalPages: number };
  source: string;
  type: 'bar' | 'line' | 'donut' | 'table';
  data: Array<Record<string, string | number>>;
  schema?: Array<{ name: string; type: string }>;
  chart?: { xAxis: { field: string; label: string; scale?: 'category' | 'time'; timeUnit?: 'millisecond' | 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year' }; yAxis: { field: string; label: string; scale?: 'category' | 'time' }; yAxes?: Array<{ field: string; label: string; scale?: 'category' | 'time' }>; yAggregation: string };
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
  tableCanScrollLeft = false;
  tableCanScrollRight = false;
  private tableDragStartX = 0;
  private tableDragStartScrollLeft = 0;
  private tableDragElement?: HTMLElement;
  private tableDragging = false;
  private lineCanvas?: ElementRef<HTMLCanvasElement>;
  private lineChart?: Chart<'line', (number | { x: string; y: number })[], string>;
  private barCanvas?: ElementRef<HTMLCanvasElement>;
  private barChart?: Chart<'bar', number[], string>;

  @ViewChild('lineCanvas')
  set lineCanvasElement(value: ElementRef<HTMLCanvasElement> | undefined) {
    this.lineCanvas = value;
    if (value) this.scheduleLineChartRender();
  }

  @ViewChild('barCanvas')
  set barCanvasElement(value: ElementRef<HTMLCanvasElement> | undefined) {
    this.barCanvas = value;
    if (value) this.scheduleBarChartRender();
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

  ngOnDestroy(): void { this.lineChart?.destroy(); this.barChart?.destroy(); }

  loadVisualization(id: string | null): void {
    this.visualization = undefined;
    this.error = '';
    if (!id) { this.error = 'Visualization not found.'; this.loading = false; return; }
    this.loading = true;
    this.http.get<Visualization>(`${this.apiUrl}/visualizations/${id}`).subscribe({
      next: (item) => { this.visualization = item; this.filterValues = Object.fromEntries(item.filterControls.map((control) => [this.filterKey(control), null])); this.loading = false; this.scheduleLineChartRender(); this.scheduleBarChartRender(); this.scheduleTableScrollStateUpdate(); },
      error: (response) => { this.error = response.status === 404 ? 'Visualization not found.' : response.error?.message ?? 'Could not load the visualization.'; this.loading = false; }
    });
  }

  applyFilters(page = 1): void {
    if (!this.visualization) return;
    this.loading = true;
    this.error = '';
    this.http.post<Visualization>(`${this.apiUrl}/visualizations/${this.visualization.id}/query`, { filters: this.filterValues, page }).subscribe({
      next: (item) => { this.visualization = item; this.loading = false; this.scheduleLineChartRender(); this.scheduleBarChartRender(); this.scheduleTableScrollStateUpdate(); },
      error: (response) => { this.error = response.error?.message ?? 'Could not apply filters.'; this.loading = false; }
    });
  }

  clearFilters(): void {
    for (const field of Object.keys(this.filterValues)) this.filterValues[field] = null;
    this.applyFilters();
  }

  goToTablePage(page: number): void {
    const pagination = this.visualization?.pagination;
    if (!pagination || page < 1 || page > pagination.totalPages || page === pagination.page) return;
    if (!this.visualization) return;
    this.loading = true;
    this.http.post<Visualization>(`${this.apiUrl}/visualizations/${this.visualization.id}/query`, { filters: this.filterValues, page }).subscribe({
      next: (item) => { this.visualization = item; this.loading = false; this.scheduleLineChartRender(); this.scheduleBarChartRender(); },
      error: (response) => { this.error = response.error?.message ?? 'Could not load that page.'; this.loading = false; }
    });
  }

  updateTableScrollState(event: Event): void {
    const element = event.currentTarget as HTMLElement;
    this.tableCanScrollLeft = element.scrollLeft > 1;
    this.tableCanScrollRight = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
  }

  startTableDrag(event: MouseEvent): void {
    const element = event.currentTarget as HTMLElement;
    this.tableDragElement = element;
    this.tableDragStartX = event.clientX;
    this.tableDragStartScrollLeft = element.scrollLeft;
    this.tableDragging = false;
  }

  moveTableDrag(event: MouseEvent): void {
    if (!this.tableDragElement || event.buttons !== 1) return;
    const distance = event.clientX - this.tableDragStartX;
    if (Math.abs(distance) > 3) this.tableDragging = true;
    this.tableDragElement.scrollLeft = this.tableDragStartScrollLeft - distance;
  }

  endTableDrag(): void {
    this.tableDragElement = undefined;
    this.tableDragging = false;
  }

  suppressTableClick(event: MouseEvent): void {
    if (this.tableDragging) event.preventDefault();
  }

  private scheduleTableScrollStateUpdate(): void {
    setTimeout(() => {
      requestAnimationFrame(() => {
        const element = document.querySelector<HTMLElement>('.table-scroll');
        if (element) this.updateTableScrollState({ currentTarget: element } as unknown as Event);
      });
    });
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

  private scheduleBarChartRender(): void {
    setTimeout(() => this.renderBarChart());
  }

  private renderBarChart(): void {
    if (this.visualization?.type !== 'bar' || !this.barCanvas) {
      this.barChart?.destroy();
      this.barChart = undefined;
      return;
    }
    this.barChart?.destroy();
    const values = this.visualization.data.map((item) => Math.max(this.chartValue(item), 0));
    const maximum = Math.max(0, ...values);
    const precision = values.some((value) => !Number.isInteger(value)) ? 2 : 0;
    const isHorizontal = values.length > 12;
    this.barChart = new Chart<'bar', number[], string>(this.barCanvas.nativeElement, {
      type: 'bar',
      data: {
        labels: this.visualization.data.map((item) => this.chartLabel(item)),
        datasets: [{ label: this.visualization.chart?.yAxis.label ?? 'Value', data: values, backgroundColor: values.map((_value, index) => index % 3 === 2 ? '#d77b43' : '#73b58e'), borderRadius: 5, borderSkipped: false, categoryPercentage: .8, barPercentage: .7, maxBarThickness: values.length > 12 ? 42 : 78 }]
      },
      options: {
        indexAxis: isHorizontal ? 'y' : 'x',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { displayColors: false, padding: 10 } },
        scales: isHorizontal ? {
          x: { beginAtZero: true, suggestedMax: maximum || 1, title: { display: true, text: this.visualization.chart?.yAxis.label ?? 'Value', color: '#718078', font: { size: 11, weight: 600 } }, grid: { color: '#e8efeb' }, border: { display: false }, ticks: { color: '#718078', padding: 8, precision } },
          y: { grid: { display: false }, border: { display: false }, ticks: { color: '#718078', autoSkip: false, padding: 8 } }
        } : {
          x: { grid: { display: false }, border: { display: false }, ticks: { color: '#718078', autoSkip: false, maxRotation: 60, minRotation: 45, padding: 8 } },
          y: { beginAtZero: true, suggestedMax: maximum || 1, title: { display: true, text: this.visualization.chart?.yAxis.label ?? 'Value', color: '#718078', font: { size: 11, weight: 600 } }, grid: { color: '#e8efeb' }, border: { display: false }, ticks: { color: '#718078', padding: 8, precision } }
        }
      }
    });
  }

  private renderLineChart(): void {
    if (this.visualization?.type !== 'line' || !this.lineCanvas) {
      this.lineChart?.destroy();
      this.lineChart = undefined;
      return;
    }
    this.lineChart?.destroy();
    const chart = this.visualization.chart;
    const xAxisField = chart?.xAxis.field;
    const numericFields = [...new Set(this.visualization.data.flatMap((item) => Object.entries(item).filter(([field, value]) => field !== xAxisField && typeof value === 'number').map(([field]) => field)))];
    const yAxisField = chart?.yAxis.field;
    const configuredFields = chart?.yAxes?.map((axis) => axis.field).filter((field) => numericFields.includes(field)) ?? [];
    const seriesFields = configuredFields.length
      ? [...configuredFields, ...numericFields.filter((field) => !configuredFields.includes(field))]
      : yAxisField && numericFields.includes(yAxisField)
        ? [yAxisField, ...numericFields.filter((field) => field !== yAxisField)]
        : numericFields;
    const colors = ['#1f7055', '#d77b43', '#4e7891', '#b38b4a', '#c65d4c', '#73b58e'];
    const isTimeScale = chart?.xAxis.scale === 'time';
    this.lineChart = new Chart<'line', (number | { x: string; y: number })[], string>(this.lineCanvas.nativeElement, {
      type: 'line',
      data: {
        labels: isTimeScale ? undefined : this.visualization.data.map((item) => this.chartLabel(item)),
        datasets: seriesFields.map((field, index) => ({
          label: chart?.yAxes?.find((axis) => axis.field === field)?.label ?? (field === yAxisField ? chart?.yAxis.label ?? field : field),
          data: isTimeScale
            ? this.visualization!.data.map((item) => ({ x: this.chartTimeValue(item), y: Number(item[field] ?? 0) }))
            : this.visualization!.data.map((item) => Number(item[field] ?? 0)),
          borderColor: colors[index % colors.length],
          backgroundColor: `${colors[index % colors.length]}18`,
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 5,
          pointBackgroundColor: colors[index % colors.length],
          pointBorderColor: '#ffffff',
          pointBorderWidth: 2,
          tension: .28,
          fill: seriesFields.length === 1
        }))
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: { display: seriesFields.length > 1, position: 'bottom', labels: { color: '#718078', usePointStyle: true, padding: 18 } },
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
