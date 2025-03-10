/**
 * The main idea and some parts of the code (e.g. drawing variable width Bézier curve) are taken from:
 * http://corner.squareup.com/2012/07/smoother-signatures.html
 *
 * Implementation of interpolation using cubic Bézier curves is taken from:
 * https://web.archive.org/web/20160323213433/http://www.benknowscode.com/2012/09/path-interpolation-using-cubic-bezier_9742.html
 *
 * Algorithm for approximated length of a Bézier curve is taken from:
 * http://www.lemoda.net/maths/bezier-length/index.html
 */

import { Bezier } from './bezier';
import { BasicPoint, Point } from './point';
import { SignatureEventTarget } from './signature_event_target';
import { throttle } from './throttle';

declare global {
  interface CSSStyleDeclaration {
    msTouchAction: string | null;
  }
}

export type SignatureEvent = MouseEvent | Touch | PointerEvent;

export interface FromDataOptions {
  clear?: boolean;
}

export interface PointGroupOptions {
  dotSize: number;
  minWidth: number;
  maxWidth: number;
  penColor: string;
}

export interface Options extends Partial<PointGroupOptions> {
  minDistance?: number;
  velocityFilterWeight?: number;
  backgroundColor?: string;
  throttle?: number;
  resizeOptions?: ResizeOptions;
}

export interface ResizeOptions {
  isDesktopOrTablet: boolean;
  containerElem: HTMLElement;
}

export interface PointGroup extends PointGroupOptions {
  points: BasicPoint[];
}

export default class SignaturePad extends SignatureEventTarget {
  // Public stuff
  public dotSize: number;
  public minWidth: number;
  public maxWidth: number;
  public penColor: string;
  public minDistance: number;
  public velocityFilterWeight: number;
  public backgroundColor: string;
  public throttle: number;
  public semaforo: boolean;

  private _isDesktopOrTablet: boolean;
  private _parentContainer: HTMLElement;

  // Private stuff
  /* tslint:disable: variable-name */
  private _ctx: CanvasRenderingContext2D;
  private _drawningStroke: boolean;
  private _isEmpty: boolean;
  private _lastPoints: Point[]; // Stores up to 4 most recent points; used to generate a new curve
  private _data: PointGroup[]; // Stores all points in groups (one group per line or dot)
  private _lastVelocity: number;
  private _lastWidth: number;
  private _strokeMoveUpdate: (event: SignatureEvent) => void;

  /* tslint:enable: variable-name */

  /**
   * Constructor
   * we suggest this css class on the canvas in order to fill the available space
   *
   * .fill-available {
   *   height: available;
   *   height: -webkit-fill-available;
   *   height: -moz-available;
   *   width: available;
   *   width: -moz-available;
   *   width: -webkit-fill-available;
   * }
   *
   * @param canvas
   * @param options
   */
  constructor(private canvas: HTMLCanvasElement, options: Options = {}) {
    super();
    this.velocityFilterWeight = options.velocityFilterWeight || 0.7;
    this.minWidth = options.minWidth || 0.5;
    this.maxWidth = options.maxWidth || 2.5;
    this.throttle = ('throttle' in options ? options.throttle : 16) as number; // in milisecondss
    this.minDistance = (
      'minDistance' in options ? options.minDistance : 5
    ) as number; // in pixels
    this.dotSize = options.dotSize || 0;
    this.penColor = options.penColor || 'black';
    this.backgroundColor = options.backgroundColor || 'rgba(0,0,0,0)';

    this._strokeMoveUpdate = this.throttle
      ? throttle(SignaturePad.prototype._strokeUpdate, this.throttle)
      : SignaturePad.prototype._strokeUpdate;

    // TODO descrivere
    const { resizeOptions } = options;
    if (resizeOptions) {
      if (resizeOptions.isDesktopOrTablet === undefined) {
        resizeOptions.isDesktopOrTablet = true;
      }

      this._parentContainer = resizeOptions.containerElem;
      this._isDesktopOrTablet = resizeOptions.isDesktopOrTablet;

      this.resizeCanvas(canvas);
    } else {
      this._ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    }

    this.clear();

    // Enable mouse and touch event handlers
    this.on();
  }

  /**
   * this function is used to resize the canvas, thanks to the CSS class fill-available: it will fill all the available space.
   * we made two different type of resize, for desktop with regular coordinates (width = x and height = y) and for mobile ( width = y and height = x)
   * we had to do that because in our application we use ionic framework so in mobile layout using ion-col we had to reverse the coordinates in order to have a
   * good response from the pad.
   * We make use of a little refactoring (y > 0 ? y - (y * 6) / 100 - 10 : screen.width), because in our application the canvas doesn't fill all available space, so I had to adapt its dimension
   * , so I had to adapt the canvas (If the canvas is supposed to fill all available space, you can just use (y > 0 ? y : screen.width))
   * @param containerElem
   * @param window
   * @param canvas
   * @param isDesktopOrTablet
   */

  public resizeCanvas(canvas: HTMLCanvasElement): void {
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const y = this._parentContainer.clientHeight;
    const x = this._parentContainer.clientWidth;
    if (this._isDesktopOrTablet) {
      canvas.width = (y > 0 ? y - (y * 6) / 100 - 10 : screen.width) * ratio;
      canvas.height = (x > 0 ? x - (x * 6) / 100 - 10 : screen.height) * ratio;
    } else {
      canvas.width = (x > 0 ? x - (x * 6) / 100 - 10 : screen.width) * ratio;
      canvas.height = (y > 0 ? y - (y * 6) / 100 - 10 : screen.height) * ratio;
    }
    this._ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    this._ctx.scale(ratio, ratio);
    window.onresize = () => this.resizeCanvas(canvas);
  }

  public clear(): void {
    const { _ctx: ctx, canvas } = this;

    // Clear canvas using background color
    ctx.fillStyle = this.backgroundColor;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    this._data = [];
    this._reset();
    this._isEmpty = true;
  }

  public fromDataURL(
    dataUrl: string,
    options: {
      ratio?: number;
      width?: number;
      height?: number;
      xOffset?: number;
      yOffset?: number;
    } = {},
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const ratio = options.ratio || window.devicePixelRatio || 1;
      const width = options.width || this.canvas.width / ratio;
      const height = options.height || this.canvas.height / ratio;
      const xOffset = options.xOffset || 0;
      const yOffset = options.yOffset || 0;

      this._reset();

      image.onload = (): void => {
        this._ctx.drawImage(image, xOffset, yOffset, width, height);
        resolve();
      };
      image.onerror = (error): void => {
        reject(error);
      };
      image.crossOrigin = 'anonymous';
      image.src = dataUrl;

      this._isEmpty = false;
    });
  }

  public toDataURL(type = 'image/png', encoderOptions?: number): string {
    switch (type) {
      case 'image/svg+xml':
        return this._toSVG();
      default:
        return this.canvas.toDataURL(type, encoderOptions);
    }
  }

  public on(): void {
    // Disable panning/zooming when touching canvas element
    this.canvas.style.touchAction = 'none';
    this.canvas.style.msTouchAction = 'none';
    this.canvas.style.userSelect = 'none';

    const isIOS =
      /Macintosh/.test(navigator.userAgent) && 'ontouchstart' in document;

    // The "Scribble" feature of iOS intercepts point events. So that we can lose some of them when tapping rapidly.
    // Use touch events for iOS platforms to prevent it. See https://developer.apple.com/forums/thread/664108 for more information.
    if (window.PointerEvent && !isIOS) {
      this._handlePointerEvents();
    } else {
      this._handleMouseEvents();

      if ('ontouchstart' in window) {
        this._handleTouchEvents();
      }
    }
  }

  public off(): void {
    // Enable panning/zooming when touching canvas element
    this.canvas.style.touchAction = 'auto';
    this.canvas.style.msTouchAction = 'auto';
    this.canvas.style.userSelect = 'auto';

    this.canvas.removeEventListener('pointerdown', this._handlePointerStart);
    this.canvas.removeEventListener('pointermove', this._handlePointerMove);
    document.removeEventListener('pointerup', this._handlePointerEnd);

    this.canvas.removeEventListener('mousedown', this._handleMouseDown);
    this.canvas.removeEventListener('mousemove', this._handleMouseMove);
    document.removeEventListener('mouseup', this._handleMouseUp);

    this.canvas.removeEventListener('touchstart', this._handleTouchStart);
    this.canvas.removeEventListener('touchmove', this._handleTouchMove);
    this.canvas.removeEventListener('touchend', this._handleTouchEnd);
  }

  public isEmpty(): boolean {
    return this._isEmpty;
  }

  public fromData(
    pointGroups: PointGroup[],
    { clear = true }: FromDataOptions = {},
  ): void {
    if (clear) {
      this.clear();
    }

    this._fromData(
      pointGroups,
      this._drawCurve.bind(this),
      this._drawDot.bind(this),
    );

    this._data = clear ? pointGroups : this._data.concat(pointGroups);
  }

  public toData(): PointGroup[] {
    return this._data;
  }

  // Event handlers
  private _handleMouseDown = (event: MouseEvent): void => {
    if (event.buttons === 1) {
      this._drawningStroke = true;
      this._strokeBegin(event);
    }
  };

  private _handleMouseMove = (event: MouseEvent): void => {
    if (this._drawningStroke) {
      this._strokeMoveUpdate(event);
    }
  };

  private _handleMouseUp = (event: MouseEvent): void => {
    if (event.buttons === 1 && this._drawningStroke) {
      this._drawningStroke = false;
      this._strokeEnd(event);
    }
  };

  private _handleTouchStart = (event: TouchEvent): void => {
    // Prevent scrolling.
    event.preventDefault();

    if (event.targetTouches.length === 1) {
      const touch = event.changedTouches[0];
      this._strokeBegin(touch);
    }
  };

  private _handleTouchMove = (event: TouchEvent): void => {
    // Prevent scrolling.
    event.preventDefault();

    const touch = event.targetTouches[0];
    this._strokeMoveUpdate(touch);
  };

  private _handleTouchEnd = (event: TouchEvent): void => {
    const wasCanvasTouched = event.target === this.canvas;
    if (wasCanvasTouched) {
      event.preventDefault();

      const touch = event.changedTouches[0];
      this._strokeEnd(touch);
    }
  };

  private _handlePointerStart = (event: PointerEvent): void => {
    this._drawningStroke = true;
    event.preventDefault();
    this._strokeBegin(event);
  };

  private _handlePointerMove = (event: PointerEvent): void => {
    if (this._drawningStroke) {
      event.preventDefault();
      this._strokeMoveUpdate(event);
    }
  };

  private _handlePointerEnd = (event: PointerEvent): void => {
    this._drawningStroke = false;
    const wasCanvasTouched = event.target === this.canvas;
    if (wasCanvasTouched) {
      event.preventDefault();
      this._strokeEnd(event);
    }
  };

  // Private methods
  private _strokeBegin(event: SignatureEvent): void {
    this.dispatchEvent(new CustomEvent('beginStroke', { detail: event }));

    const newPointGroup: PointGroup = {
      dotSize: this.dotSize,
      minWidth: this.minWidth,
      maxWidth: this.maxWidth,
      penColor: this.penColor,
      points: [],
    };

    this._data.push(newPointGroup);
    this._reset();
    this._strokeUpdate(event);
  }

  private _strokeUpdate(event: SignatureEvent): void {
    if (this._data.length === 0) {
      // This can happen if clear() was called while a signature is still in progress,
      // or if there is a race condition between start/update events.
      this._strokeBegin(event);
      return;
    }

    this.dispatchEvent(
      new CustomEvent('beforeUpdateStroke', { detail: event }),
    );

    const x = event.clientX;
    const y = event.clientY;
    const pressure =
      (event as PointerEvent).pressure !== undefined
        ? (event as PointerEvent).pressure
        : (event as Touch).force !== undefined
        ? (event as Touch).force
        : 0;

    const point = this._createPoint(x, y, pressure);
    const lastPointGroup = this._data[this._data.length - 1];
    const lastPoints = lastPointGroup.points;
    const lastPoint =
      lastPoints.length > 0 && lastPoints[lastPoints.length - 1];
    const isLastPointTooClose = lastPoint
      ? point.distanceTo(lastPoint) <= this.minDistance
      : false;
    const { penColor, dotSize, minWidth, maxWidth } = lastPointGroup;

    // Skip this point if it's too close to the previous one
    if (!lastPoint || !(lastPoint && isLastPointTooClose)) {
      const curve = this._addPoint(point);

      if (!lastPoint) {
        this._drawDot(point, {
          penColor,
          dotSize,
          minWidth,
          maxWidth,
        });
      } else if (curve) {
        this._drawCurve(curve, {
          penColor,
          dotSize,
          minWidth,
          maxWidth,
        });
      }

      lastPoints.push({
        time: point.time,
        x: point.x,
        y: point.y,
        pressure: point.pressure,
      });
    }

    this.dispatchEvent(new CustomEvent('afterUpdateStroke', { detail: event }));
  }

  private _strokeEnd(event: SignatureEvent): void {
    this._strokeUpdate(event);

    this.dispatchEvent(new CustomEvent('endStroke', { detail: event }));
  }

  private _handlePointerEvents(): void {
    this._drawningStroke = false;

    this.canvas.addEventListener('pointerdown', this._handlePointerStart);
    this.canvas.addEventListener('pointermove', this._handlePointerMove);
    document.addEventListener('pointerup', this._handlePointerEnd);
  }

  private _handleMouseEvents(): void {
    this._drawningStroke = false;

    this.canvas.addEventListener('mousedown', this._handleMouseDown);
    this.canvas.addEventListener('mousemove', this._handleMouseMove);
    document.addEventListener('mouseup', this._handleMouseUp);
  }

  private _handleTouchEvents(): void {
    this.canvas.addEventListener('touchstart', this._handleTouchStart);
    this.canvas.addEventListener('touchmove', this._handleTouchMove);
    this.canvas.addEventListener('touchend', this._handleTouchEnd);
  }

  // Called when a new line is started
  private _reset(): void {
    this._lastPoints = [];
    this._lastVelocity = 0;
    this._lastWidth = (this.minWidth + this.maxWidth) / 2;
    this._ctx.fillStyle = this.penColor;
  }

  private _createPoint(x: number, y: number, pressure: number): Point {
    const rect = this.canvas.getBoundingClientRect();

    return new Point(
      x - rect.left,
      y - rect.top,
      pressure,
      new Date().getTime(),
    );
  }

  // Add point to _lastPoints array and generate a new curve if there are enough points (i.e. 3)
  private _addPoint(point: Point): Bezier | null {
    const { _lastPoints } = this;

    _lastPoints.push(point);

    if (_lastPoints.length > 2) {
      // To reduce the initial lag make it work with 3 points
      // by copying the first point to the beginning.
      if (_lastPoints.length === 3) {
        _lastPoints.unshift(_lastPoints[0]);
      }

      // _points array will always have 4 points here.
      const widths = this._calculateCurveWidths(_lastPoints[1], _lastPoints[2]);
      const curve = Bezier.fromPoints(_lastPoints, widths);

      // Remove the first element from the list, so that there are no more than 4 points at any time.
      _lastPoints.shift();

      return curve;
    }

    return null;
  }

  private _calculateCurveWidths(
    startPoint: Point,
    endPoint: Point,
  ): { start: number; end: number } {
    const velocity =
      this.velocityFilterWeight * endPoint.velocityFrom(startPoint) +
      (1 - this.velocityFilterWeight) * this._lastVelocity;

    const newWidth = this._strokeWidth(velocity);

    const widths = {
      end: newWidth,
      start: this._lastWidth,
    };

    this._lastVelocity = velocity;
    this._lastWidth = newWidth;

    return widths;
  }

  private _strokeWidth(velocity: number): number {
    return Math.max(this.maxWidth / (velocity + 1), this.minWidth);
  }

  private _drawCurveSegment(x: number, y: number, width: number): void {
    const ctx = this._ctx;

    ctx.moveTo(x, y);
    ctx.arc(x, y, width, 0, 2 * Math.PI, false);
    this._isEmpty = false;
  }

  private _drawCurve(curve: Bezier, options: PointGroupOptions): void {
    const ctx = this._ctx;
    const widthDelta = curve.endWidth - curve.startWidth;
    // '2' is just an arbitrary number here. If only lenght is used, then
    // there are gaps between curve segments :/
    const drawSteps = Math.ceil(curve.length()) * 2;

    ctx.beginPath();
    ctx.fillStyle = options.penColor;

    for (let i = 0; i < drawSteps; i += 1) {
      // Calculate the Bezier (x, y) coordinate for this step.
      const t = i / drawSteps;
      const tt = t * t;
      const ttt = tt * t;
      const u = 1 - t;
      const uu = u * u;
      const uuu = uu * u;

      let x = uuu * curve.startPoint.x;
      x += 3 * uu * t * curve.control1.x;
      x += 3 * u * tt * curve.control2.x;
      x += ttt * curve.endPoint.x;

      let y = uuu * curve.startPoint.y;
      y += 3 * uu * t * curve.control1.y;
      y += 3 * u * tt * curve.control2.y;
      y += ttt * curve.endPoint.y;

      const width = Math.min(
        curve.startWidth + ttt * widthDelta,
        options.maxWidth,
      );
      this._drawCurveSegment(x, y, width);
    }

    ctx.closePath();
    ctx.fill();
  }

  private _drawDot(point: BasicPoint, options: PointGroupOptions): void {
    const ctx = this._ctx;
    const width =
      options.dotSize > 0
        ? options.dotSize
        : (options.minWidth + options.maxWidth) / 2;

    ctx.beginPath();
    this._drawCurveSegment(point.x, point.y, width);
    ctx.closePath();
    ctx.fillStyle = options.penColor;
    ctx.fill();
  }

  private _fromData(
    pointGroups: PointGroup[],
    drawCurve: SignaturePad['_drawCurve'],
    drawDot: SignaturePad['_drawDot'],
  ): void {
    for (const group of pointGroups) {
      const { penColor, dotSize, minWidth, maxWidth, points } = group;

      if (points.length > 1) {
        for (let j = 0; j < points.length; j += 1) {
          const basicPoint = points[j];
          const point = new Point(
            basicPoint.x,
            basicPoint.y,
            basicPoint.pressure,
            basicPoint.time,
          );

          // All points in the group have the same color, so it's enough to set
          // penColor just at the beginning.
          this.penColor = penColor;

          if (j === 0) {
            this._reset();
          }

          const curve = this._addPoint(point);

          if (curve) {
            drawCurve(curve, {
              penColor,
              dotSize,
              minWidth,
              maxWidth,
            });
          }
        }
      } else {
        this._reset();

        drawDot(points[0], {
          penColor,
          dotSize,
          minWidth,
          maxWidth,
        });
      }
    }
  }

  private _toSVG(): string {
    const pointGroups = this._data;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const minX = 0;
    const minY = 0;
    const maxX = this.canvas.width / ratio;
    const maxY = this.canvas.height / ratio;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');

    svg.setAttribute('width', this.canvas.width.toString());
    svg.setAttribute('height', this.canvas.height.toString());

    this._fromData(
      pointGroups,

      (curve, { penColor }) => {
        const path = document.createElement('path');

        // Need to check curve for NaN values, these pop up when drawing
        // lines on the canvas that are not continuous. E.g. Sharp corners
        // or stopping mid-stroke and than continuing without lifting mouse.
        /* eslint-disable no-restricted-globals */
        if (
          !isNaN(curve.control1.x) &&
          !isNaN(curve.control1.y) &&
          !isNaN(curve.control2.x) &&
          !isNaN(curve.control2.y)
        ) {
          const attr =
            `M ${curve.startPoint.x.toFixed(3)},${curve.startPoint.y.toFixed(
              3,
            )} ` +
            `C ${curve.control1.x.toFixed(3)},${curve.control1.y.toFixed(3)} ` +
            `${curve.control2.x.toFixed(3)},${curve.control2.y.toFixed(3)} ` +
            `${curve.endPoint.x.toFixed(3)},${curve.endPoint.y.toFixed(3)}`;
          path.setAttribute('d', attr);
          path.setAttribute('stroke-width', (curve.endWidth * 2.25).toFixed(3));
          path.setAttribute('stroke', penColor);
          path.setAttribute('fill', 'none');
          path.setAttribute('stroke-linecap', 'round');

          svg.appendChild(path);
        }
        /* eslint-enable no-restricted-globals */
      },

      (point, { penColor, dotSize, minWidth, maxWidth }) => {
        const circle = document.createElement('circle');
        const size = dotSize > 0 ? dotSize : (minWidth + maxWidth) / 2;
        circle.setAttribute('r', size.toString());
        circle.setAttribute('cx', point.x.toString());
        circle.setAttribute('cy', point.y.toString());
        circle.setAttribute('fill', penColor);

        svg.appendChild(circle);
      },
    );

    const prefix = 'data:image/svg+xml;base64,';
    const header =
      '<svg' +
      ' xmlns="http://www.w3.org/2000/svg"' +
      ' xmlns:xlink="http://www.w3.org/1999/xlink"' +
      ` viewBox="${minX} ${minY} ${this.canvas.width} ${this.canvas.height}"` +
      ` width="${maxX}"` +
      ` height="${maxY}"` +
      '>';
    let body = svg.innerHTML;

    // IE hack for missing innerHTML property on SVGElement
    if (body === undefined) {
      const dummy = document.createElement('dummy');
      const nodes = svg.childNodes;
      dummy.innerHTML = '';

      // tslint:disable-next-line: prefer-for-of
      for (let i = 0; i < nodes.length; i += 1) {
        dummy.appendChild(nodes[i].cloneNode(true));
      }

      body = dummy.innerHTML;
    }

    const footer = '</svg>';
    const data = header + body + footer;

    return prefix + btoa(data);
  }
}
