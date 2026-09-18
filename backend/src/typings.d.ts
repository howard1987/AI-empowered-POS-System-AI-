/**
 * P3 治理 · onnxruntime-node 类型垫片
 * 官方未随包提供声明文件；本项目仅使用 InferenceSession / Tensor 两个成员，
 * 以最小面（any 兜底成员）声明，满足 noImplicitAny 下「类型 + 值」双重引用。
 */
declare module 'onnxruntime-node' {
  export class Tensor {
    constructor(...args: any[]);
    data: any;
    location: any;
    [key: string]: any;
  }
  export class InferenceSession {
    static create(...args: any[]): Promise<InferenceSession>;
    run(...args: any[]): Promise<any>;
    inputNames: string[];
    outputNames: string[];
    [key: string]: any;
  }
}
