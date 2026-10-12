import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, ElementRef, OnDestroy, OnInit, ViewChild, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ArcElement, BarController, BarElement, CategoryScale, Chart, DoughnutController, Filler, Legend, LineController, LineElement, LinearScale, Plugin, PointElement, TimeScale, Tooltip } from 'chart.js';
import 'chartjs-adapter-date-fns';

Chart.register(ArcElement, BarController, BarElement, CategoryScale, DoughnutController, Filler, Legend, LineController, LineElement, LinearScale, PointElement, TimeScale, Tooltip);

const donutLabelsPlugin: Plugin<'doughnut'> = {
  id: 'donutLabels',
  afterDatasetsDraw(chart) {
    const context = chart.ctx;
    context.save();
    context.fillStyle = '#ffffff';
    context.font = '600 10px Arial';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    chart.data.datasets.forEach((dataset, datasetIndex) => {
      const values = (dataset.data ?? []).map((value) => Number(value));
      const total = values.reduce((sum, value) => sum + Math.max(value, 0), 0);
      if (!total) return;
      chart.getDatasetMeta(datasetIndex).data.forEach((arc, index) => {
        const value = Math.max(values[index] ?? 0, 0);
        if (!value) return;
        const position = arc.tooltipPosition(false);
        if (position.x == null || position.y == null) return;
        context.fillText(`${Math.round(value / total * 100)}%`, position.x, position.y);
      });
    });
    context.restore();
  }
};

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
  filterOptions?: Record<string, Array<string | number | boolean>>;
  selectMode?: 'single' | 'multiple';
  defaultSelects?: string[];
  schema?: Array<{ name: string; type: string }>;
  chart?: { xAxis: { field: string; label: string; scale?: 'category' | 'time'; timeUnit?: 'millisecond' | 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year' }; yAxis: { field: string; label: string; scale?: 'category' | 'time' }; yAxes?: Array<{ field: string; label: string; scale?: 'category' | 'time' }>; yAggregation: string };
  filterControls: Array<{ field: string; label: string; type: 'text' | 'number' | 'boolean' | 'date' | 'time' | 'datetime'; operator: string; range?: 'from' | 'to'; category?: boolean }>;
  queryPlan?: { select: Array<{ field: string; label?: string }>; groupBy: string[]; page: number; pageSize: number; filterGroups: Array<Array<{ field: string; operator: string; value: string | number | boolean }>>; sort: { field: string; direction: string } | null };
}
type FilterValue = string | number | boolean | null;
type RefreshInterval = 0 | 30_000 | 60_000 | 300_000;

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
  selectedField = '';
  selectedFields: string[] = [];
  private chartTypeOverride?: 'bar' | 'donut';
  refreshInterval: RefreshInterval = 0;
  tableCanScrollLeft = false;
  tableCanScrollRight = false;
  private tableDragStartX = 0;
  private tableDragStartScrollLeft = 0;
  private tableDragElement?: HTMLElement;
  private tableDragging = false;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private lineCanvas?: ElementRef<HTMLCanvasElement>;
  private lineChart?: Chart<'line', (number | { x: string; y: number })[], string>;
  private barCanvas?: ElementRef<HTMLCanvasElement>;
  private barChart?: Chart<'bar', number[], string>;
  private donutCanvas?: ElementRef<HTMLCanvasElement>;
  private donutChart?: Chart<'doughnut', number[], string>;

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

  @ViewChild('donutCanvas')
  set donutCanvasElement(value: ElementRef<HTMLCanvasElement> | undefined) {
    this.donutCanvas = value;
    if (value) this.scheduleDonutChartRender();
  }

  filterKey(control: Visualization['filterControls'][number]): string {
    return `${control.field}::${control.operator}`;
  }

  filterCount(): number {
    return this.visualization?.queryPlan?.filterGroups.reduce((count, group) => count + group.length, 0) ?? 0;
  }

  ngOnInit(): void {
    this.route.paramMap.subscribe((params) => {
      const id = params.get('id');
      this.loadVisualization(id);
    });
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.lineChart?.destroy();
    this.barChart?.destroy();
    this.donutChart?.destroy();
  }

  setRefreshInterval(interval: RefreshInterval): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    this.refreshInterval = interval;
    if (interval === 0) return;
    this.refreshTimer = setInterval(() => {
      if (this.loading || !this.visualization) return;
      this.applyFilters(this.visualization.pagination?.page ?? 1);
    }, interval);
  }

  loadVisualization(id: string | null): void {
    this.visualization = undefined;
    this.chartTypeOverride = undefined;
    this.error = '';
    if (!id) { this.error = 'Visualization not found.'; this.loading = false; return; }
    this.loading = true;
    this.http.get<Visualization>(`${this.apiUrl}/visualizations/${id}`).subscribe({
      next: (item) => { this.visualization = item; this.initializeDisplaySelection(item); this.filterValues = Object.fromEntries(item.filterControls.map((control) => [this.filterKey(control), null])); this.loading = false; this.scheduleLineChartRender(); this.scheduleBarChartRender(); this.scheduleDonutChartRender(); this.scheduleTableScrollStateUpdate(); },
      error: (response) => { this.error = response.status === 404 ? 'Visualization not found.' : response.error?.message ?? 'Could not load the visualization.'; this.loading = false; }
    });
  }

  applyFilters(page = 1): void {
    if (!this.visualization) return;
    this.loading = true;
    this.error = '';
    this.http.post<Visualization>(`${this.apiUrl}/visualizations/${this.visualization.id}/query`, { filters: this.filterValues, page }).subscribe({
      next: (item) => { this.visualization = item; this.loading = false; this.scheduleLineChartRender(); this.scheduleBarChartRender(); this.scheduleDonutChartRender(); this.scheduleTableScrollStateUpdate(); },
      error: (response) => { this.error = response.error?.message ?? 'Could not apply filters.'; this.loading = false; }
    });
  }

  clearFilters(): void {
    for (const field of Object.keys(this.filterValues)) this.filterValues[field] = null;
    this.applyFilters();
  }

  selectableFields(): string[] {
    if (this.visualization?.type === 'table') {
      return this.availableTableFields();
    }
    const xAxisField = this.visualization?.chart?.xAxis.field;
    return this.visualization?.queryPlan?.select.map((selection) => selection.field).filter((field) => field !== xAxisField) ?? [];
  }

  private availableTableFields(item = this.visualization): string[] {
    if (!item) return [];
    const returnedFields = item.data[0] ? Object.keys(item.data[0]) : [];
    return returnedFields.length ? returnedFields : item.queryPlan?.select.map((selection) => selection.field) ?? [];
  }

  fieldLabel(field: string, label?: string): string {
    const selection = this.visualization?.queryPlan?.select.find((item) => item.field === field);
    const value = label || selection?.label || field.replace(/^joined\./i, '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
    return field.startsWith('joined.') ? value.replace(/^joined(?:[.\s]+)+/i, '') : value;
  }

  onDisplaySelectionChange(): void {
    if (this.visualization?.selectMode === 'multiple') {
      this.selectedFields = this.selectedFields.filter((field) => this.selectableFields().includes(field));
      if (!this.selectedFields.length) this.selectedFields = [this.selectableFields()[0]];
    } else {
      this.selectedField = this.selectableFields().includes(this.selectedField) ? this.selectedField : this.selectableFields()[0] ?? '';
      this.selectedFields = this.selectedField ? [this.selectedField] : [];
    }
    this.scheduleLineChartRender();
    this.scheduleBarChartRender();
    this.scheduleDonutChartRender();
  }

  toggleDisplayField(field: string): void {
    if (!this.visualization) return;
    if (this.visualization.selectMode === 'multiple') {
      this.selectedFields = this.selectedFields.includes(field) ? this.selectedFields.filter((selected) => selected !== field) : [...this.selectedFields, field];
    } else {
      this.selectedField = field;
    }
    this.onDisplaySelectionChange();
  }

  clearDisplayFields(): void {
    if (this.visualization?.selectMode !== 'multiple') return;
    this.selectedFields = this.selectableFields().slice(0, 1);
    this.selectedField = this.selectedFields[0] ?? '';
    this.onDisplaySelectionChange();
  }

  goToTablePage(page: number): void {
    const pagination = this.visualization?.pagination;
    if (!pagination || page < 1 || page > pagination.totalPages || page === pagination.page) return;
    if (!this.visualization) return;
    this.loading = true;
    this.http.post<Visualization>(`${this.apiUrl}/visualizations/${this.visualization.id}/query`, { filters: this.filterValues, page }).subscribe({
      next: (item) => { this.visualization = item; this.loading = false; this.scheduleLineChartRender(); this.scheduleBarChartRender(); this.scheduleDonutChartRender(); },
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

  private scheduleDonutChartRender(): void {
    setTimeout(() => this.renderDonutChart());
  }

  private initializeDisplaySelection(item: Visualization): void {
    const fields = item.type === 'table'
      ? this.availableTableFields(item)
      : item.queryPlan?.select.map((selection) => selection.field).filter((field) => field !== item.chart?.xAxis.field) ?? [];
    const defaults = (item.defaultSelects ?? []).filter((field) => fields.includes(field));
    if (item.selectMode === 'multiple') {
      this.selectedFields = defaults.length ? defaults : fields;
      this.selectedField = this.selectedFields[0] ?? '';
    } else {
      this.selectedField = defaults[0] ?? fields[0] ?? '';
      this.selectedFields = this.selectedField ? [this.selectedField] : [];
    }
  }

  displayFields(): string[] {
    const selected = this.visualization?.selectMode === 'multiple' ? this.selectedFields : this.selectedField ? [this.selectedField] : [];
    if (this.visualization?.type === 'table') {
      const fields = new Set(this.availableTableFields());
      return selected.filter((field) => fields.has(field));
    }
    return selected;
  }

  displayChartType(): Visualization['type'] {
    const item = this.visualization;
    if (!item) return 'table';
    if (item.type === 'donut') return this.chartTypeOverride === 'bar' ? 'bar' : 'donut';
    if (item.type !== 'bar') return item.type;
    return this.chartTypeOverride === 'donut' ? 'donut' : 'bar';
  }

  canSwitchChartType(): boolean {
    const item = this.visualization;
    return item?.type === 'donut' || (item?.type === 'bar' && (this.chartTypeOverride === 'donut' || this.canSwitchToDonut(item)));
  }

  setChartType(type: 'bar' | 'donut'): void {
    if (!this.canSwitchChartType()) return;
    this.chartTypeOverride = type;
    this.scheduleBarChartRender();
    this.scheduleDonutChartRender();
  }

  private canSwitchToDonut(item: Visualization): boolean {
    const groupBy = item.queryPlan?.groupBy ?? [];
    if (groupBy.length !== 1 || groupBy[0] !== item.chart?.xAxis.field || item.data.length < 2 || item.data.length > 6) return false;
    const chart = item.chart;
    if (!chart) return false;
    const selectedMeasures = (item.selectMode === 'multiple' ? this.selectedFields : this.selectedField ? [this.selectedField] : [])
      .filter((field) => field === chart.yAxis.field || chart.yAxes?.some((axis) => axis.field === field));
    return selectedMeasures.length <= 1;
  }

  private renderDonutChart(): void {
    const visualization = this.visualization;
    if (!visualization || this.displayChartType() !== 'donut' || !this.donutCanvas) {
      this.donutChart?.destroy();
      this.donutChart = undefined;
      return;
    }
    this.donutChart?.destroy();
    const colors = ['#2b805d', '#d77b43', '#73b58e', '#c65d4c', '#4e7891', '#b38b4a'];
    const measures = this.selectedMeasureFields(visualization);
    this.donutChart = new Chart<'doughnut', number[], string>(this.donutCanvas.nativeElement, {
      type: 'doughnut',
      data: {
        labels: visualization.data.map((item) => this.chartLabel(item)),
        datasets: measures.map((field) => ({
          label: this.fieldLabel(field, visualization.chart?.yAxes?.find((axis) => axis.field === field)?.label ?? (field === visualization.chart?.yAxis.field ? visualization.chart.yAxis.label : undefined)),
          data: visualization.data.map((item) => Math.max(this.chartValue(item, field), 0)),
          backgroundColor: visualization.data.map((_item, index) => colors[index % colors.length]),
          borderColor: '#ffffff',
          borderWidth: 3,
          hoverOffset: 6
        }))
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { position: 'right', labels: { color: '#718078', padding: 14, usePointStyle: true } },
          tooltip: {
            displayColors: false,
            padding: 10,
            callbacks: { label: (context) => `${context.dataset.label}: ${context.formattedValue}` }
          }
        }
      },
      plugins: [donutLabelsPlugin]
    });
  }

  private selectedMeasureFields(visualization: Visualization): string[] {
    const chart = visualization.chart;
    if (!chart) return [];
    const selectedMeasures = this.displayFields().filter((field) => field === chart.yAxis.field || chart.yAxes?.some((axis) => axis.field === field));
    return selectedMeasures.length ? selectedMeasures : [chart.yAxis.field];
  }

  private renderBarChart(): void {
    const visualization = this.visualization;
    if (!visualization || this.displayChartType() !== 'bar' || !this.barCanvas) {
      this.barChart?.destroy();
      this.barChart = undefined;
      return;
    }
    this.barChart?.destroy();
    const selectedMeasures = this.selectedMeasureFields(visualization);
    const measureLabel = (field: string): string => this.fieldLabel(field, visualization.chart?.yAxes?.find((axis) => axis.field === field)?.label ?? (field === visualization.chart?.yAxis.field ? visualization.chart.yAxis.label : undefined));
    const xAxisField = visualization.chart?.xAxis.field;
    const groupBy = visualization.queryPlan?.groupBy ?? [];
    const seriesField = groupBy.length >= 2 && groupBy[0] === xAxisField ? groupBy[1] : undefined;
    const groupedLabels = seriesField ? [...new Set(visualization.data.map((item) => this.chartLabel({ [xAxisField!]: item[xAxisField!]})))] : [];
    const seriesLabels = seriesField ? [...new Set(visualization.data.map((item) => this.chartLabel({ [xAxisField!]: item[seriesField] })))] : [];
    const seriesColors = ['#73b58e', '#d77b43', '#4e7891', '#b38b4a', '#c65d4c', '#756bb1', '#a64d79', '#4f8b8b', '#9a6b38', '#3f6fa3', '#8c5948', '#2b805d'];
    const findRow = (label: string, series?: string): Record<string, string | number> | undefined => visualization.data.find((item) =>
      this.chartLabel({ [xAxisField!]: item[xAxisField!] }) === label
      && (!seriesField || this.chartLabel({ [xAxisField!]: item[seriesField] }) === series)
    );
    const datasets = seriesField
      ? selectedMeasures.flatMap((field, measureIndex) => seriesLabels.map((series, seriesIndex) => ({
        label: `${measureLabel(field)} · ${series}`,
        data: groupedLabels.map((label) => Math.max(this.chartValue(findRow(label, series) ?? {}, field), 0)),
        backgroundColor: seriesColors[(measureIndex * seriesLabels.length + seriesIndex) % seriesColors.length],
        borderRadius: 5,
        borderSkipped: false as const,
        categoryPercentage: .8,
        barPercentage: .7,
        maxBarThickness: groupedLabels.length > 12 ? 42 : 78
      })))
      : selectedMeasures.map((field, measureIndex) => {
        const values = visualization.data.map((item) => Math.max(this.chartValue(item, field), 0));
        return {
          label: measureLabel(field),
          data: values,
          backgroundColor: selectedMeasures.length === 1
            ? values.map((_value, index) => index % 3 === 2 ? '#d77b43' : '#73b58e')
            : seriesColors[measureIndex % seriesColors.length],
          borderRadius: 5,
          borderSkipped: false as const,
          categoryPercentage: .8,
          barPercentage: .7,
          maxBarThickness: values.length > 12 ? 42 : 78
        };
      });
    const values = datasets.flatMap((dataset) => dataset.data);
    const maximum = Math.max(0, ...values);
    const precision = values.some((value) => !Number.isInteger(value)) ? 2 : 0;
    const isHorizontal = (seriesField ? groupedLabels.length : visualization.data.length) > 12;
    const labels = seriesField ? groupedLabels : visualization.data.map((item) => this.chartLabel(item));
    const legendDisplay = Boolean(seriesField) || selectedMeasures.length > 1;
    const axisTitle = selectedMeasures.length > 1 ? 'Value' : measureLabel(selectedMeasures[0] ?? '');
    this.barChart = new Chart<'bar', number[], string>(this.barCanvas.nativeElement, {
      type: 'bar',
      data: {
        labels,
        datasets
      },
      options: {
        indexAxis: isHorizontal ? 'y' : 'x',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: legendDisplay, labels: { color: '#718078', usePointStyle: true } }, tooltip: { displayColors: legendDisplay, padding: 10 } },
        scales: isHorizontal ? {
          x: { beginAtZero: true, suggestedMax: maximum || 1, title: { display: true, text: axisTitle, color: '#718078', font: { size: 11, weight: 600 } }, grid: { color: '#e8efeb' }, border: { display: false }, ticks: { color: '#718078', padding: 8, precision } },
          y: { grid: { display: false }, border: { display: false }, ticks: { color: (context) => String(context.tick.label) === 'NULL' ? '#c65d4c' : '#718078', autoSkip: false, padding: 8 } }
        } : {
          x: { grid: { display: false }, border: { display: false }, ticks: { color: (context) => String(context.tick.label) === 'NULL' ? '#c65d4c' : '#718078', autoSkip: false, maxRotation: 60, minRotation: 45, padding: 8 } },
          y: { beginAtZero: true, suggestedMax: maximum || 1, title: { display: true, text: axisTitle, color: '#718078', font: { size: 11, weight: 600 } }, grid: { color: '#e8efeb' }, border: { display: false }, ticks: { color: '#718078', padding: 8, precision } }
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
    const selectedFields = new Set(this.displayFields());
    const yAxisField = chart?.yAxis.field;
    const numericFields = [...new Set(this.visualization.data.flatMap((item) => Object.entries(item).filter(([field, value]) => field !== xAxisField && (selectedFields.has(field) || (chart?.yAggregation === 'count' && field === yAxisField)) && typeof value === 'number').map(([field]) => field)))];
    const configuredFields = chart?.yAxes?.map((axis) => axis.field).filter((field) => numericFields.includes(field)) ?? [];
    const seriesFields = configuredFields.length
      ? [...configuredFields, ...numericFields.filter((field) => !configuredFields.includes(field))]
      : yAxisField && numericFields.includes(yAxisField)
        ? [yAxisField, ...numericFields.filter((field) => field !== yAxisField)]
        : numericFields;
    const colors = ['#1f7055', '#d77b43', '#4e7891', '#b38b4a', '#c65d4c', '#73b58e', '#756bb1', '#a64d79', '#4f8b8b', '#9a6b38', '#3f6fa3', '#8c5948'];
    const colorForField = (field: string): string => colors[Math.max(this.selectableFields().indexOf(field), 0) % colors.length];
    const isTimeScale = chart?.xAxis.scale === 'time';
    this.lineChart = new Chart<'line', (number | { x: string; y: number })[], string>(this.lineCanvas.nativeElement, {
      type: 'line',
      data: {
        labels: isTimeScale ? undefined : this.visualization.data.map((item) => this.chartLabel(item)),
        datasets: seriesFields.map((field) => {
          const color = colorForField(field);
          return {
            label: this.fieldLabel(field, chart?.yAxes?.find((axis) => axis.field === field)?.label ?? (field === yAxisField ? chart?.yAxis.label : undefined)),
            data: isTimeScale
              ? this.visualization!.data.map((item) => ({ x: this.chartTimeValue(item), y: Number(item[field] ?? 0) }))
              : this.visualization!.data.map((item) => Number(item[field] ?? 0)),
            borderColor: color,
            backgroundColor: `${color}18`,
            borderWidth: 2,
            pointRadius: 4,
            pointHoverRadius: 5,
            pointBackgroundColor: color,
            pointBorderColor: '#ffffff',
            pointBorderWidth: 2,
            tension: .28,
            fill: seriesFields.length === 1
          };
        })
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
            title: { display: true, text: chart ? this.fieldLabel(chart.xAxis.field, chart.xAxis.label) : 'X axis', color: '#718078', font: { size: 11, weight: 600 } },
            grid: { display: false },
            border: { display: false },
            time: { unit: this.visualization.chart?.xAxis.timeUnit ?? 'day' },
            ticks: { color: (context) => String(context.tick.label) === 'NULL' ? '#c65d4c' : '#718078', maxRotation: 0, autoSkip: true, padding: 8 }
          },
          y: {
            beginAtZero: true,
            title: { display: true, text: chart ? this.fieldLabel(chart.yAxis.field, chart.yAxis.label) : 'Value', color: '#718078', font: { size: 11, weight: 600 } },
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

  chartValue(item: Record<string, string | number>, field = this.visualization?.chart?.yAxis.field): number { return Number(field ? item[field] ?? 0 : Object.values(item).find((value) => typeof value === 'number') ?? 0); }
  displayValue(value: string | number): string {
    if (typeof value !== 'string') return String(value);
    try { const parsed = JSON.parse(value); return typeof parsed === 'string' ? parsed : value; } catch { return value.replace(/^"|"$/g, ''); }
  }
  tableCellValue(value: string | number): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(value)) return this.displayValue(value);
    const date = new Date(value.replace(' ', 'T'));
    if (Number.isNaN(date.getTime())) return value;
    const hasSeconds = /[T ]\d{2}:\d{2}:\d{2}/.test(value);
    const hasTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      ...(hasTimeZone ? { timeZone: 'UTC' } : {}),
      ...(hasSeconds ? { second: '2-digit' as const } : {})
    }).format(date);
  }
  chartLabel(item: Record<string, string | number>): string { const field = this.visualization?.chart?.xAxis.field; const label = this.displayValue(field ? item[field] ?? '' : Object.values(item).find((value) => typeof value === 'string') ?? ''); return label.trim() ? label : 'NULL'; }
  chartTimeValue(item: Record<string, string | number>): string { return this.chartLabel(item).replace(/Z$/, ''); }
  keys(): string[] {
    const returnedFields = this.visualization?.data[0] ? Object.keys(this.visualization.data[0]) : [];
    if (this.visualization?.type === 'table') {
      const selectedFields = new Set(this.displayFields());
      return this.availableTableFields().filter((field) => returnedFields.includes(field) && selectedFields.has(field));
    }
    const fields = this.displayFields();
    return [...fields.filter((field) => returnedFields.includes(field)), ...returnedFields.filter((field) => !fields.includes(field))];
  }
  sortSummary(): string { const sort = this.visualization?.queryPlan?.sort; return sort ? `${sort.field} ${sort.direction}` : 'Default order'; }
  queryParameterName(index: number): string { return `p${index}`; }
  queryParameterValue(value: string | number | boolean): string { return typeof value === 'string' ? JSON.stringify(value) : String(value); }
}
