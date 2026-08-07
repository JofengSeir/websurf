//! 错误模块

use thiserror::Error;

/// 错误类型
#[derive(Error, Debug, miette::Diagnostic)]
pub enum Error {
    /// 资源未找到
    #[error("资源未找到: {0}")]
    ResourceNotFound(String),
    
    /// 其他错误
    #[error("{0}")]
    Other(String),
    
    /// IO 错误
    #[error("IO 错误: {0}")]
    IoError(#[from] std::io::Error),
    
    /// UTF-8 错误
    #[error("UTF-8 错误: {0}")]
    Utf8Error(#[from] std::string::FromUtf8Error),
    
    /// VTF 错误
    #[error("VTF 错误: {0}")]
    VtfError(#[from] vtf::Error),
    
    /// VDF 错误
    #[error("VDF 错误: {0}")]
    VdfError(#[from] vmt_parser::VdfError),
    
    /// GLTF JSON 错误
    #[error("GLTF JSON 错误: {0}")]
    GltfJsonError(#[from] gltf_json::Error),
    
    /// 模型集成错误
    #[error("模型集成错误: {0}")]
    ModelIntegratorError(#[from] crate::model_integrator::ModelIntegratorError),
}
