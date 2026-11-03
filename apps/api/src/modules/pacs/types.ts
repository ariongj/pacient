export interface WindowSetting {
  /** Window width (contrast). */
  width: number;
  /** Window level/centre (brightness). */
  level: number;
}

export interface ImageInstance {
  uid: string;
  number: number;
}

export interface ImageSeries {
  uid: string;
  number: number;
  description: string;
  modality: string;
  instances: ImageInstance[];
}

export interface RenderedImage {
  contentType: string;
  body: Buffer;
}
